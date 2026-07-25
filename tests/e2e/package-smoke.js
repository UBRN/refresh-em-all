const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

const {
  RUNTIME_FILES,
  extractZip,
  getReleaseMetadata,
  verifyZip
} = require('../../scripts/package-extension');

const repositoryRoot = path.resolve(__dirname, '../..');
const outputDirectory = path.join(repositoryRoot, 'test-results', 'e2e', 'package-smoke');

function extensionIdForPath(extensionPath) {
  const canonicalPath = fs.realpathSync(extensionPath);
  return [...crypto.createHash('sha256').update(canonicalPath).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(nibble => String.fromCharCode(97 + nibble))
    .join('');
}

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Extracted package contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) return listFiles(absolutePath, relativePath);
      if (!entry.isFile()) throw new Error(`Extracted package contains a non-regular file: ${relativePath}`);
      return [relativePath];
    })
    .sort();
}

function writeJson(filename, value) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

async function createServer() {
  const page = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Packaged extension smoke</title></head>
  <body>
    <h1>Packaged extension smoke</h1>
    <script>
      sessionStorage.packageSmokeLoads = String(Number(sessionStorage.packageSmokeLoads || 0) + 1);
      window.packageSmokeReady = true;
    </script>
  </body>
</html>`;
  const server = http.createServer((request, response) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(page),
      'Content-Type': 'text/html; charset=utf-8'
    });
    response.end(page);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/smoke`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function screenshot(page, filename) {
  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true });
    }
  } catch (error) {
    return { filename, error: error.message };
  }
  return { filename };
}

async function main() {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });

  execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'package-extension.js')], {
    cwd: repositoryRoot,
    stdio: 'inherit'
  });

  const { manifest, version, zipPath } = getReleaseMetadata();
  const verifiedPackage = verifyZip(zipPath, manifest);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-em-all-package-smoke-'));
  const extractedExtensionPath = path.join(temporaryRoot, 'extension');
  const sourceExtensionId = extensionIdForPath(repositoryRoot);
  let extractedFiles = [];
  let packagedExtensionId;
  let browser;
  let popup;
  let testPage;
  let server;
  const diagnostics = { pageErrors: [], requestFailures: [] };
  const startedAt = performance.now();

  try {
    extractedFiles = extractZip(zipPath, extractedExtensionPath);
    packagedExtensionId = extensionIdForPath(extractedExtensionPath);
    if (JSON.stringify(extractedFiles) !== JSON.stringify(RUNTIME_FILES)) {
      throw new Error('Extracted files do not match the package runtime allowlist');
    }
    if (JSON.stringify(listFiles(extractedExtensionPath)) !== JSON.stringify(RUNTIME_FILES)) {
      throw new Error('Extracted package contains missing or unexpected files');
    }
    if (packagedExtensionId === sourceExtensionId) {
      throw new Error('Packaged smoke path unexpectedly resolves to the source extension ID');
    }

    server = await createServer();
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 800, height: 700 },
      args: [
        `--disable-extensions-except=${extractedExtensionPath}`,
        `--load-extension=${extractedExtensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
        ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])
      ]
    });

    const attachDiagnostics = page => {
      page.on('pageerror', error => diagnostics.pageErrors.push({ url: page.url(), message: error.message }));
      page.on('requestfailed', request => diagnostics.requestFailures.push({
        url: request.url(),
        error: request.failure()?.errorText || 'unknown request failure'
      }));
      return page;
    };

    testPage = attachDiagnostics(await browser.newPage());
    await testPage.goto(server.url);
    await testPage.waitForFunction(() => window.packageSmokeReady === true, { timeout: 10000 });

    popup = attachDiagnostics(await browser.newPage());
    const popupUrl = `chrome-extension://${packagedExtensionId}/popup.html`;
    await popup.goto(popupUrl);
    const extensionState = await popup.evaluate(() => ({
      manifestVersion: chrome.runtime.getManifest().version,
      rootUrl: chrome.runtime.getURL(''),
      scriptUrls: [...document.scripts].map(script => script.src).filter(Boolean),
      title: document.title
    }));

    if (extensionState.manifestVersion !== version) {
      throw new Error(`Loaded manifest version ${extensionState.manifestVersion}, expected ${version}`);
    }
    if (extensionState.rootUrl !== `chrome-extension://${packagedExtensionId}/`) {
      throw new Error(`Browser loaded an unexpected extension root: ${extensionState.rootUrl}`);
    }
    if (extensionState.scriptUrls.some(url => !url.startsWith(extensionState.rootUrl))) {
      throw new Error(`Popup loaded a script outside the extracted extension: ${extensionState.scriptUrls.join(', ')}`);
    }
    if (!extensionState.title.includes('Refresh Em All')) {
      throw new Error(`Unexpected popup title: ${extensionState.title}`);
    }

    await popup.click('#refreshAll');
    await testPage.waitForFunction(
      () => Number(sessionStorage.packageSmokeLoads) === 2,
      { timeout: 15000 }
    );
    await popup.waitForFunction(async () => {
      const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
      return refreshHistory[0]?.successfulTabs === 1;
    }, { timeout: 15000 });

    const result = await popup.evaluate(async () => {
      const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
      return {
        history: refreshHistory[0],
        progress: document.querySelector('#progressFill')?.style.width || '',
        status: document.querySelector('#statusText')?.textContent || ''
      };
    });
    if (result.progress !== '100%') throw new Error(`Expected 100% progress, got ${result.progress}`);
    if (diagnostics.pageErrors.length > 0) {
      throw new Error(`Packaged extension page errors: ${JSON.stringify(diagnostics.pageErrors)}`);
    }

    writeJson('result.json', {
      result: 'passed',
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
      zipPath: path.relative(repositoryRoot, zipPath),
      zipSize: verifiedPackage.size,
      extractedFiles,
      packagedExtensionId,
      sourceExtensionId,
      extensionState,
      refresh: result,
      diagnostics
    });
    console.log(`Packaged-extension smoke test passed for ${path.relative(repositoryRoot, zipPath)}.`);
  } catch (error) {
    const screenshots = await Promise.all([
      screenshot(popup, 'popup.png'),
      screenshot(testPage, 'page.png')
    ]);
    writeJson('failure.json', {
      result: 'failed',
      error: { message: error.message, stack: error.stack },
      zipPath: path.relative(repositoryRoot, zipPath),
      extractedExtensionPath,
      extractedFiles,
      packagedExtensionId,
      sourceExtensionId,
      diagnostics,
      screenshots
    });
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Packaged-extension smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
