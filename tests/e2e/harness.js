const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const extensionPath = path.join(__dirname, '../..');
const outputRoot = path.join(extensionPath, 'test-results', 'e2e');
const ciBrowserArgs = process.env.CI === 'true' ? ['--no-sandbox'] : [];

function createTone() {
  const sampleRate = 8000;
  const durationSeconds = 180;
  const samples = sampleRate * durationSeconds;
  const bytesPerSample = 2;
  const dataSize = samples * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples; index++) {
    const sample = Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.15;
    wav.writeInt16LE(Math.round(sample * 32767), 44 + index * bytesPerSample);
  }

  return wav;
}

function renderPage(pathname) {
  const mediaMode = pathname === '/media-paused'
    ? 'paused'
    : pathname === '/media-playing'
      ? 'playing'
      : null;
  const mediaMarkup = mediaMode
    ? `<audio id="testAudio" preload="auto" src="/tone.wav"></audio>
       <button id="configureMedia" type="button">Configure ${mediaMode} media</button>`
    : '';

  return `<!doctype html>
<html>
  <head><title>Refresh test ${pathname}</title></head>
  <body>
    <h1>Refresh Em All local test page</h1>
    ${mediaMarkup}
    <script>
      sessionStorage.refreshAuditLoads = String(Number(sessionStorage.refreshAuditLoads || 0) + 1);
      sessionStorage.reliabilityLoads = String(Number(sessionStorage.reliabilityLoads || 0) + 1);
      window.mediaMode = ${JSON.stringify(mediaMode)};
      window.mediaConfigured = false;

      const configureButton = document.querySelector('#configureMedia');
      if (configureButton) {
        configureButton.addEventListener('click', () => {
          const audio = document.querySelector('#testAudio');
          audio.currentTime = 3;
          audio.volume = window.mediaMode === 'playing' ? 0.45 : 0.35;
          audio.muted = false;
          audio.playbackRate = 1.25;

          if (window.mediaMode === 'playing') {
            Promise.resolve(audio.play()).then(() => {
              window.mediaConfigured = true;
            }).catch(error => {
              window.mediaConfigurationError = error.message;
            });
          } else {
            audio.pause();
            window.mediaConfigured = true;
          }
        });
      }

      window.reliabilityReady = true;
    </script>
  </body>
</html>`;
}

async function createTestServer() {
  const tone = createTone();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

    if (pathname === '/tone.wav') {
      const range = request.headers.range;
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2] ? Number(match[2]) : tone.length - 1;
      const end = Math.min(requestedEnd, tone.length - 1);
      const body = tone.subarray(start, end + 1);
      const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
        'Content-Type': 'audio/wav'
      };

      if (match) headers['Content-Range'] = `bytes ${start}-${end}/${tone.length}`;
      response.writeHead(match ? 206 : 200, headers);
      response.end(body);
      return;
    }

    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    const page = renderPage(pathname);
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
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

function deriveExtensionId() {
  return [...crypto.createHash('sha256').update(extensionPath).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(nibble => String.fromCharCode(97 + nibble))
    .join('');
}

async function findExtensionId(browser) {
  const existingTarget = browser.targets().find(candidate =>
    candidate.type() === 'service_worker'
    && candidate.url().startsWith('chrome-extension://'));
  if (existingTarget) return new URL(existingTarget.url()).host;
  return deriveExtensionId();
}

function createPhaseTimer(profile, basePhases = {}, totalStarted = performance.now()) {
  const phasesMs = { ...basePhases };
  const startedAt = new Date().toISOString();

  return {
    async measure(name, operation) {
      const started = performance.now();
      try {
        return await operation();
      } finally {
        phasesMs[name] = Number((performance.now() - started).toFixed(1));
      }
    },
    set(name, durationMs) {
      phasesMs[name] = Number(durationMs.toFixed(1));
    },
    snapshot(result, metadata = {}) {
      return {
        profile,
        startedAt,
        result,
        phasesMs: {
          ...phasesMs,
          total: Number((performance.now() - totalStarted).toFixed(1))
        },
        ...metadata
      };
    }
  };
}

async function runPool(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function waitForCondition(check, { timeout, interval = 50, description }) {
  const deadline = Date.now() + timeout;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`);
}

function attachPageDiagnostics(page, diagnostics, label) {
  page.on('console', message => {
    diagnostics.console.push({ label, type: message.type(), text: message.text() });
  });
  page.on('pageerror', error => {
    diagnostics.pageErrors.push({ label, message: error.message, stack: error.stack });
  });
  page.on('requestfailed', request => {
    diagnostics.requestFailures.push({
      label,
      url: request.url(),
      error: request.failure()?.errorText || 'unknown request failure'
    });
  });
  return page;
}

function attachWorkerDiagnostics(browser, diagnostics) {
  const attachedTargets = new WeakSet();

  async function attach(target) {
    if (target.type() !== 'service_worker' || !target.url().startsWith('chrome-extension://')) return;
    if (attachedTargets.has(target)) return;
    attachedTargets.add(target);
    try {
      const session = await target.createCDPSession();
      await session.send('Runtime.enable');
      session.on('Runtime.consoleAPICalled', event => {
        diagnostics.workerConsole.push({
          type: event.type,
          text: event.args.map(argument => argument.value ?? argument.description ?? '').join(' ')
        });
      });
      session.on('Runtime.exceptionThrown', event => {
        diagnostics.workerConsole.push({
          type: 'exception',
          text: event.exceptionDetails.exception?.description || event.exceptionDetails.text
        });
      });
    } catch (error) {
      diagnostics.workerConsole.push({ type: 'diagnostic-error', text: error.message });
    }
  }

  browser.on('targetcreated', attach);
  browser.targets().forEach(target => attach(target));
}

async function clearStorage(controlPage) {
  await controlPage.evaluate(async () => {
    await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'cancelOperation' }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    const clearArea = area => area
      ? new Promise(resolve => area.clear(() => resolve()))
      : Promise.resolve();
    await clearArea(chrome.storage.local);
    await clearArea(chrome.storage.session);
  });
}

async function removeWindows(controlPage, windowIds) {
  await runPool(windowIds, 2, windowId => controlPage.evaluate(id =>
    new Promise(resolve => {
      chrome.windows.remove(id, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    }), windowId));
}

function ensureOutputDirectory(profile) {
  const outputDirectory = path.join(outputRoot, profile);
  fs.mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

function prepareOutputDirectory(profile) {
  const outputDirectory = path.join(outputRoot, profile);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function safeScreenshot(page, screenshotPath) {
  try {
    if (!page?.isClosed()) await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    return { path: screenshotPath, error: error.message };
  }
  return { path: screenshotPath };
}

async function captureFailureDiagnostics({
  profile,
  error,
  popup,
  pages = [],
  diagnostics,
  additionalState = {}
}) {
  const outputDirectory = ensureOutputDirectory(profile);
  const screenshots = [];
  screenshots.push(await safeScreenshot(popup, path.join(outputDirectory, 'popup.png')));

  const pageStates = await runPool(pages, 8, async page => {
    try {
      return await page.evaluate(() => {
        const audio = document.querySelector('#testAudio');
        return {
          url: location.href,
          loads: Number(sessionStorage.reliabilityLoads),
          ready: window.reliabilityReady === true,
          media: audio ? {
            currentTime: audio.currentTime,
            muted: audio.muted,
            paused: audio.paused,
            playbackRate: audio.playbackRate,
            volume: audio.volume
          } : null
        };
      });
    } catch (pageError) {
      return { url: page.url(), diagnosticError: pageError.message };
    }
  });
  const pagesByPriority = pages
    .map((page, index) => ({ page, state: pageStates[index] }))
    .sort((left, right) => {
      const leftPriority = left.state.media ? 0 : left.state.loads !== 2 ? 1 : 2;
      const rightPriority = right.state.media ? 0 : right.state.loads !== 2 ? 1 : 2;
      return leftPriority - rightPriority;
    })
    .slice(0, 5);

  for (let index = 0; index < pagesByPriority.length; index++) {
    screenshots.push(await safeScreenshot(
      pagesByPriority[index].page,
      path.join(outputDirectory, `page-${index + 1}.png`)
    ));
  }

  let browserState;
  try {
    browserState = await popup?.evaluate(async () => {
      const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
      const tabs = await chrome.tabs.query({});
      return {
        history: refreshHistory[0],
        progress: document.querySelector('#progressFill')?.style.width || '',
        status: document.querySelector('#statusText')?.textContent || '',
        tabs: tabs.map(tab => ({ id: tab.id, status: tab.status, url: tab.url, windowId: tab.windowId }))
      };
    });
  } catch (stateError) {
    browserState = { diagnosticError: stateError.message };
  }

  const payload = {
    error: { message: error.message, stack: error.stack },
    browserState,
    diagnostics,
    pageStates,
    screenshots,
    ...additionalState
  };
  writeJson(path.join(outputDirectory, 'failure.json'), payload);
  return payload;
}

async function createHarness({ profile, trace = false } = {}) {
  const startedAt = performance.now();
  const outputDirectory = prepareOutputDirectory(profile);
  const basePhases = {};
  const diagnostics = { console: [], pageErrors: [], requestFailures: [], workerConsole: [] };

  const serverStarted = performance.now();
  const testServer = await createTestServer();
  basePhases.serverSetup = Number((performance.now() - serverStarted).toFixed(1));

  let browser;
  let controlPage;
  let tracePath;
  let tracePage;

  try {
    const browserStarted = performance.now();
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=500,700',
        ...ciBrowserArgs
      ]
    });
    basePhases.browserLaunch = Number((performance.now() - browserStarted).toFixed(1));
    attachWorkerDiagnostics(browser, diagnostics);

    const discoveryStarted = performance.now();
    const extensionId = await findExtensionId(browser);
    controlPage = attachPageDiagnostics(await browser.newPage(), diagnostics, 'control');
    await controlPage.goto(`chrome-extension://${extensionId}/popup.html`);
    basePhases.extensionDiscovery = Number((performance.now() - discoveryStarted).toFixed(1));

    return {
      basePhases,
      baseUrl: testServer.baseUrl,
      browser,
      controlPage,
      diagnostics,
      extensionId,
      outputDirectory,
      startedAt,
      attachPage(page, label) {
        return attachPageDiagnostics(page, diagnostics, label);
      },
      async resetState() {
        await clearStorage(controlPage);
      },
      async removeWindows(windowIds) {
        await removeWindows(controlPage, windowIds);
      },
      async startTrace(page = controlPage) {
        if (!trace || tracePath) return;
        tracePage = page;
        tracePath = path.join(outputDirectory, 'trace.json');
        await tracePage.tracing.start({
          path: tracePath,
          categories: [
            'devtools.timeline',
            'disabled-by-default-devtools.timeline'
          ]
        });
      },
      async stopTrace({ keep }) {
        if (!tracePath || !tracePage) return;
        await tracePage.tracing.stop();
        if (!keep && fs.existsSync(tracePath)) fs.rmSync(tracePath);
        tracePath = null;
        tracePage = null;
      },
      async close() {
        if (tracePath && tracePage) await this.stopTrace({ keep: true });
        if (browser) await browser.close();
        await testServer.close();
      }
    };
  } catch (error) {
    if (browser) await browser.close();
    await testServer.close();
    throw error;
  }
}

module.exports = {
  captureFailureDiagnostics,
  createHarness,
  createPhaseTimer,
  ensureOutputDirectory,
  prepareOutputDirectory,
  runPool,
  waitForCondition,
  writeJson
};
