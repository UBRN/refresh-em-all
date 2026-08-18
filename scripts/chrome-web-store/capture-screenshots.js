#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const { extractZip, parseZip, RUNTIME_FILES } = require('../package-extension');

const repositoryRoot = path.resolve(__dirname, '../..');
const screenshotRoot = path.join(repositoryRoot, 'docs/chrome-web-store/assets/screenshots');
const resultDirectory = path.join(repositoryRoot, 'test-results/chrome-web-store');
const localeRoot = path.join(repositoryRoot, '_locales');
const defaultExpectedVersion = require(path.join(repositoryRoot, 'package.json')).version;
const fixedHistoryTimestamp = '2026-01-15T12:00:00.000Z';

// The popup is localized, so every status string this capture waits on has to be rendered from
// the same catalog Chrome will use. This mirrors chrome.i18n.getMessage's substitution rules.
function loadCatalog(locale) {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'messages.json'), 'utf8'));
}

function renderMessage(catalog, key, substitutions = []) {
  const entry = catalog[key];
  if (!entry) throw new Error(`Missing message key ${key}`);
  const placeholders = new Map(
    Object.entries(entry.placeholders || {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
    const placeholder = placeholders.get(name.toLowerCase());
    if (!placeholder) return match;
    return String(placeholder.content).replace(
      /\$(\d)/g,
      (_, index) => String(substitutions[Number(index) - 1] ?? '')
    );
  });
}

// The default locale's screenshots sit directly in screenshots/; every additional Store language
// gets a sibling subdirectory named after its locale. The default locale is read from the VERIFIED
// package's manifest, not the checkout, because the package is the pinned artifact being captured.
function screenshotDirectoryFor(locale, defaultLocale) {
  return locale === defaultLocale ? screenshotRoot : path.join(screenshotRoot, locale);
}
const screenshotNames = {
  ready: '01-ready-1280x800.png',
  progress: '02-refresh-in-progress-1280x800.png',
  complete: '03-refresh-complete-1280x800.png',
  history: '04-history-1280x800.png',
  settings: '05-privacy-settings-1280x800.png'
};

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionIdForPath(extensionPath) {
  const canonicalPath = fs.realpathSync(extensionPath);
  return [...crypto.createHash('sha256').update(canonicalPath).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(nibble => String.fromCharCode(97 + nibble))
    .join('');
}

function fixtureHtml(pathname) {
  const tabNumber = pathname.replace('/tab-', '');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Example tab ${tabNumber}</title>
  </head>
  <body>
    <main><h1>Example tab ${tabNumber}</h1></main>
    <script>
      sessionStorage.storeCaptureLoads = String(Number(sessionStorage.storeCaptureLoads || 0) + 1);
      window.storeCaptureReady = true;
    </script>
  </body>
</html>`;
}

async function createFixtureServer() {
  const requestCounts = new Map();
  const gatedPaths = new Set();
  const pendingResponses = [];
  let gatesReleased = false;

  const sendPage = (pathname, response) => {
    const page = fixtureHtml(pathname);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(page),
      'Content-Type': 'text/html; charset=utf-8'
    });
    response.end(page);
  };

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!/^\/tab-[1-6]$/.test(pathname)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const count = (requestCounts.get(pathname) || 0) + 1;
    requestCounts.set(pathname, count);
    if (count >= 2 && gatedPaths.has(pathname) && !gatesReleased) {
      pendingResponses.push({ pathname, response });
      return;
    }
    sendPage(pathname, response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url(index) {
      return `${origin}/tab-${index}`;
    },
    gate(pathnames) {
      pathnames.forEach(pathname => gatedPaths.add(pathname));
    },
    pendingCount() {
      return pendingResponses.length;
    },
    release() {
      gatesReleased = true;
      while (pendingResponses.length > 0) {
        const { pathname, response } = pendingResponses.shift();
        sendPage(pathname, response);
      }
    },
    close() {
      this.release();
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  };
}

async function applyCapturePresentation(page) {
  await page.addStyleTag({ content: `
    html {
      width: 100%;
      min-height: 100%;
      background: linear-gradient(145deg, #eaf2ff 0%, #d8e7ff 100%);
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    body {
      box-sizing: content-box;
      margin: 8px auto 0 !important;
      background: #ffffff;
      border: 1px solid #c9d8ef;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(23, 78, 166, 0.18);
    }
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      caret-color: transparent !important;
    }
    #confetti { display: none !important; }
  ` });
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

async function capture(page, screenshotDirectory, filename) {
  await applyCapturePresentation(page);
  await page.mouse.move(10, 390);
  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.getBoundingClientRect().width,
    bodyHeight: document.body.getBoundingClientRect().height,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight
  }));
  if (layout.bodyWidth > 620 || layout.bodyHeight > 390) {
    throw new Error(`Popup does not fit the 640x400 capture viewport: ${JSON.stringify(layout)}`);
  }
  await page.screenshot({
    path: path.join(screenshotDirectory, filename),
    type: 'png',
    fullPage: false,
    captureBeyondViewport: false
  });
  return layout;
}

async function setSectionExpanded(page, headerSelector, contentSelector, expanded) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const visible = await page.$eval(
      contentSelector,
      element => getComputedStyle(element).display !== 'none'
    );
    if (visible === expanded) return;
    await page.click(headerSelector);
  }
  throw new Error(`Could not set ${contentSelector} expanded=${expanded}`);
}

async function freezePopupAtProgress(page, expectedStatusFragment) {
  return page.evaluate(fragment => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const freezeWhenReady = () => {
      const status = document.querySelector('#statusText')?.textContent || '';
      if (status.includes(fragment)) {
        observer.disconnect();
        document.body.replaceWith(document.body.cloneNode(true));
        resolve(status);
        return true;
      }
      if (Date.now() > deadline) {
        observer.disconnect();
        reject(new Error(`Timed out waiting for progress state ${fragment}; last status: ${status}`));
      }
      return false;
    };
    const observer = new MutationObserver(freezeWhenReady);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    freezeWhenReady();
  }), expectedStatusFragment);
}

async function waitForFixturePages(browser, urls) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const byUrl = new Map(pages.map(page => [page.url(), page]));
    if (urls.every(url => byUrl.has(url))) {
      const fixturePages = urls.map(url => byUrl.get(url));
      await Promise.all(fixturePages.map(page => page.waitForFunction(
        () => window.storeCaptureReady === true && Number(sessionStorage.storeCaptureLoads) === 1,
        { timeout: 10000 }
      )));
      return fixturePages;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for neutral fixture tabs');
}

async function createTabFixture(popup, fixtureServer) {
  const urls = Array.from({ length: 6 }, (_, index) => fixtureServer.url(index + 1));
  const result = await popup.evaluate(async fixtureUrls => {
    const currentWindow = await chrome.windows.getCurrent();
    for (const url of fixtureUrls.slice(0, 3)) {
      await chrome.tabs.create({ windowId: currentWindow.id, url, active: false });
    }
    await chrome.tabs.create({ windowId: currentWindow.id, url: 'chrome://extensions/', active: false });
    const secondWindow = await chrome.windows.create({
      url: fixtureUrls.slice(3),
      focused: false
    });
    return { currentWindowId: currentWindow.id, secondWindowId: secondWindow.id };
  }, urls);
  return { ...result, urls };
}

async function queryRefreshOrder(popup) {
  return popup.evaluate(() => new Promise((resolve, reject) => {
    chrome.tabs.query({}, tabs => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tabs.map(tab => ({
        id: tab.id,
        index: tab.index,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url
      })));
    });
  }));
}

async function verifyPackage(zipPath, expectedSha, expectedVersion) {
  const zipBuffer = fs.readFileSync(zipPath);
  const actualSha = sha256(zipBuffer);
  if (actualSha !== expectedSha) {
    throw new Error(`Expected package SHA-256 ${expectedSha}; received ${actualSha}`);
  }
  const entries = parseZip(zipBuffer);
  const names = entries.map(entry => entry.filename);
  if (JSON.stringify(names) !== JSON.stringify(RUNTIME_FILES)) {
    throw new Error('Published ZIP entries do not match the runtime allowlist');
  }
  const manifestEntry = entries.find(entry => entry.filename === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  if (manifest.version !== expectedVersion) {
    throw new Error(`Expected v${expectedVersion}, received v${manifest.version}`);
  }
  return { zipBuffer, actualSha, entries, manifest };
}

async function main() {
  const zipArgument = argumentValue('--zip');
  const expectedSha = argumentValue('--sha256');
  const expectedVersion = argumentValue('--expect-version') || defaultExpectedVersion;
  const locale = argumentValue('--locale') || 'en';
  if (!zipArgument || !expectedSha) {
    throw new Error(
      'Usage: capture-screenshots.js --zip <package.zip> --sha256 <sha256> '
      + '[--expect-version <x.y.z>] [--locale <en|tr>]'
    );
  }
  if (!fs.existsSync(path.join(localeRoot, locale, 'messages.json'))) {
    throw new Error(`Unknown capture locale ${locale}: _locales/${locale}/messages.json does not exist`);
  }

  const catalog = loadCatalog(locale);
  const expectedProgressStatus = renderMessage(catalog, 'statusProgress', [4, 8, 3, 0, 1]);
  const expectedCompleteStatus = renderMessage(catalog, 'statusCompleteSkipped', [6, 2]);
  const zipPath = path.resolve(zipArgument);
  const verifiedPackage = await verifyPackage(zipPath, expectedSha, expectedVersion);
  const screenshotDirectory = screenshotDirectoryFor(locale, verifiedPackage.manifest.default_locale);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-em-all-store-capture-'));
  const extensionPath = path.join(temporaryRoot, 'extension');
  const userDataDirectory = path.join(temporaryRoot, 'chrome-profile');
  const fixtureServer = await createFixtureServer();
  const diagnostics = { popupErrors: [], popupConsoleErrors: [] };
  let browser;
  let secondWindowId;

  // The default locale writes into the shared root, which also holds the other locales'
  // subdirectories — so clear only this locale's own files rather than the whole tree.
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  for (const filename of Object.values(screenshotNames)) {
    fs.rmSync(path.join(screenshotDirectory, filename), { force: true });
  }
  fs.mkdirSync(resultDirectory, { recursive: true });

  try {
    const extractedFiles = extractZip(zipPath, extensionPath);
    if (JSON.stringify(extractedFiles) !== JSON.stringify(RUNTIME_FILES)) {
      throw new Error('Extracted extension differs from the runtime allowlist');
    }

    browser = await puppeteer.launch({
      headless: false,
      userDataDir: userDataDirectory,
      defaultViewport: { width: 640, height: 400, deviceScaleFactor: 2 },
      env: { ...process.env, TZ: 'UTC', LANG: locale === 'en' ? 'en_US.UTF-8' : `${locale}_${locale.toUpperCase()}.UTF-8` },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // --lang drives the UI locale on Windows and Linux. macOS resolves it through Cocoa
        // instead, so the app's NSUserDefaults language list has to be overridden there.
        `--lang=${locale}`,
        ...(process.platform === 'darwin' ? ['-AppleLanguages', `(${locale})`] : []),
        '--window-size=640,400',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const extensionId = extensionIdForPath(extensionPath);
    const initialPages = await browser.pages();
    let popup = initialPages[0] || await browser.newPage();
    await popup.setViewport({ width: 640, height: 400, deviceScaleFactor: 2 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    const attachPopupDiagnostics = targetPage => {
      targetPage.on('pageerror', error => diagnostics.popupErrors.push(error.message));
      targetPage.on('console', message => {
        if (message.type() === 'error') diagnostics.popupConsoleErrors.push(message.text());
      });
    };
    attachPopupDiagnostics(popup);

    const runtimeVersion = await popup.evaluate(() => chrome.runtime.getManifest().version);
    if (runtimeVersion !== expectedVersion) throw new Error(`Loaded extension version ${runtimeVersion}`);
    const runtimeLocale = await popup.evaluate(() => chrome.i18n.getMessage('@@ui_locale'));
    if (!runtimeLocale.replace(/_/g, '-').toLowerCase().startsWith(locale.toLowerCase())) {
      throw new Error(`Requested locale ${locale} but the popup resolved @@ui_locale=${runtimeLocale}`);
    }

    const layouts = {};
    layouts.ready = await capture(popup, screenshotDirectory, screenshotNames.ready);

    const fixture = await createTabFixture(popup, fixtureServer);
    secondWindowId = fixture.secondWindowId;
    const fixturePages = await waitForFixturePages(browser, fixture.urls);
    const refreshOrder = await queryRefreshOrder(popup);
    if (refreshOrder.length !== 8) {
      throw new Error(`Expected exactly 8 tabs in the capture fixture, received ${refreshOrder.length}`);
    }
    const accessibleOrder = refreshOrder.filter(tab => tab.url?.startsWith(fixtureServer.origin));
    if (accessibleOrder.length !== 6) throw new Error(`Expected 6 accessible tabs, received ${accessibleOrder.length}`);
    await popup.click('#refreshAll');
    const frozenProgressStatus = await freezePopupAtProgress(popup, expectedProgressStatus);
    if (!frozenProgressStatus.includes(expectedProgressStatus)) {
      throw new Error(`Unexpected frozen progress state: ${frozenProgressStatus}`);
    }
    layouts.progress = await capture(popup, screenshotDirectory, screenshotNames.progress);

    await popup.close();
    popup = await browser.newPage();
    await popup.setViewport({ width: 640, height: 400, deviceScaleFactor: 2 });
    attachPopupDiagnostics(popup);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    await Promise.all(fixturePages.map(page => page.waitForFunction(
      () => Number(sessionStorage.storeCaptureLoads) === 2,
      { timeout: 15000 }
    )));
    await popup.waitForFunction(expected => {
      const status = document.querySelector('#statusText')?.textContent || '';
      return status === expected
        && document.querySelector('#progressFill')?.style.width === '100%';
    }, { timeout: 20000 }, expectedCompleteStatus);
    await new Promise(resolve => setTimeout(resolve, 3100));
    layouts.complete = await capture(popup, screenshotDirectory, screenshotNames.complete);

    await popup.evaluate(async timestamp => {
      const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
      if (refreshHistory.length !== 1) throw new Error(`Expected one history entry, received ${refreshHistory.length}`);
      refreshHistory[0].timestamp = timestamp;
      await chrome.storage.local.set({ refreshHistory });
    }, fixedHistoryTimestamp);
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('#historyContainer');
    await setSectionExpanded(popup, '#historyHeader', '#historyContent', true);
    layouts.history = await capture(popup, screenshotDirectory, screenshotNames.history);

    await setSectionExpanded(popup, '#historyHeader', '#historyContent', false);
    await setSectionExpanded(popup, '#settingsHeader', '#settingsContent', true);
    layouts.settings = await capture(popup, screenshotDirectory, screenshotNames.settings);

    if (diagnostics.popupErrors.length > 0 || diagnostics.popupConsoleErrors.length > 0) {
      throw new Error(`Popup diagnostics contain errors: ${JSON.stringify(diagnostics)}`);
    }

    const provenance = {
      package: {
        filename: path.basename(zipPath),
        sha256: verifiedPackage.actualSha,
        version: verifiedPackage.manifest.version,
        entryCount: verifiedPackage.entries.length
      },
      runtime: {
        node: process.version,
        puppeteer: require('puppeteer/package.json').version,
        browser: await browser.version(),
        extensionId,
        locale: runtimeLocale,
        timezone: 'UTC',
        viewportCss: { width: 640, height: 400 },
        deviceScaleFactor: 2,
        outputPixels: { width: 1280, height: 800 }
      },
      fixture: {
        totalTabs: 8,
        accessibleTabs: 6,
        restrictedTabs: 2,
        windows: 2,
        fixedHistoryTimestamp,
        refreshOrder: refreshOrder.map(tab => ({
          index: tab.index,
          window: tab.windowId === fixture.currentWindowId ? 'primary' : 'secondary',
          kind: tab.url?.startsWith(fixtureServer.origin) ? 'local-fixture' : 'restricted'
        }))
      },
      locale,
      screenshotDirectory: path.relative(repositoryRoot, screenshotDirectory),
      expectedStatusStrings: { progress: expectedProgressStatus, complete: expectedCompleteStatus },
      screenshots: Object.values(screenshotNames),
      layouts,
      diagnostics
    };
    fs.writeFileSync(
      path.join(resultDirectory, `capture-provenance-${locale}.json`),
      `${JSON.stringify(provenance, null, 2)}\n`
    );
    console.log(
      `Captured ${Object.values(screenshotNames).length} ${locale} Store screenshots `
      + `from the verified v${expectedVersion} package into ${path.relative(repositoryRoot, screenshotDirectory)}.`
    );
  } finally {
    fixtureServer.release();
    if (browser && secondWindowId) {
      try {
        const pages = await browser.pages();
        const extensionPage = pages.find(page => page.url().startsWith('chrome-extension://'));
        if (extensionPage) {
          await extensionPage.evaluate(windowId => new Promise(resolve => {
            chrome.windows.remove(windowId, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          }), secondWindowId);
        }
      } catch (_) {
        // Browser shutdown below is sufficient cleanup if the window is already gone.
      }
    }
    if (browser) await browser.close();
    await fixtureServer.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Store screenshot capture failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
