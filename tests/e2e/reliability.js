const http = require('http');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const extensionPath = path.join(__dirname, '../..');
const TAB_COUNT = 50;
const TABS_PER_WINDOW = TAB_COUNT / 2;
const TEST_TIMEOUT_MS = 120000;
// CI only loads this trusted extension and the localhost test server.
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
  <head><title>Reliability ${pathname}</title></head>
  <body>
    <h1>Refresh Em All reliability page</h1>
    ${mediaMarkup}
    <script>
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
            const playback = audio.play();
            Promise.resolve(playback).then(() => {
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

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function findExtensionId(browser) {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    const target = browser.targets().find(candidate =>
      candidate.type() === 'service_worker'
      && candidate.url().startsWith('chrome-extension://')
    );
    if (target) return new URL(target.url()).host;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return [...crypto.createHash('sha256').update(extensionPath).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(nibble => String.fromCharCode(97 + nibble))
    .join('');
}

async function waitForLocalPages(browser, baseUrl) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const pages = (await browser.pages()).filter(page => page.url().startsWith(baseUrl));
    if (pages.length === TAB_COUNT) return pages;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const pages = (await browser.pages()).filter(page => page.url().startsWith(baseUrl));
  throw new Error(`Expected ${TAB_COUNT} localhost tabs, found ${pages.length}`);
}

function localPageByPath(pages, pathname) {
  const page = pages.find(candidate => new URL(candidate.url()).pathname === pathname);
  if (!page) throw new Error(`Could not find test page ${pathname}`);
  return page;
}

async function configureMediaPage(page) {
  await page.waitForFunction(() => document.querySelector('#testAudio')?.readyState >= 1, {
    timeout: 10000
  });
  await page.click('#configureMedia');
  await page.waitForFunction(() => window.mediaConfigured || window.mediaConfigurationError, {
    timeout: 10000
  });

  const error = await page.evaluate(() => window.mediaConfigurationError);
  if (error) throw new Error(`Could not configure media on ${page.url()}: ${error}`);
  await page.waitForFunction(() => {
    const audio = document.querySelector('#testAudio');
    const correctPlayback = window.mediaMode === 'playing' ? !audio?.paused : audio?.paused;
    return correctPlayback
      && audio.currentTime >= 2.5
      && Math.abs(audio.playbackRate - 1.25) <= 0.01;
  }, { timeout: 10000 });
}

async function collectResult(popup, pages, baseUrl) {
  const pageStates = await Promise.all(pages.map(async page => ({
    pathname: new URL(page.url()).pathname,
    loads: await page.evaluate(() => Number(sessionStorage.reliabilityLoads))
  })));
  const popupState = await popup.evaluate(async expectedBaseUrl => {
    const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
    const tabs = await chrome.tabs.query({});
    const localTabs = tabs.filter(tab => tab.url?.startsWith(expectedBaseUrl));
    const tabsByWindow = localTabs.reduce((result, tab) => {
      result[tab.windowId] = (result[tab.windowId] || 0) + 1;
      return result;
    }, {});

    return {
      history: refreshHistory[0],
      progress: document.querySelector('#progressFill')?.style.width || '',
      status: document.querySelector('#statusText')?.textContent || '',
      tabsByWindow: Object.values(tabsByWindow).sort((left, right) => left - right)
    };
  }, baseUrl);
  const pausedMedia = await localPageByPath(pages, '/media-paused').evaluate(() => {
    const audio = document.querySelector('#testAudio');
    return {
      currentTime: audio.currentTime,
      muted: audio.muted,
      paused: audio.paused,
      playbackRate: audio.playbackRate,
      volume: audio.volume
    };
  });
  const playingMedia = await localPageByPath(pages, '/media-playing').evaluate(() => {
    const audio = document.querySelector('#testAudio');
    return {
      currentTime: audio.currentTime,
      muted: audio.muted,
      paused: audio.paused,
      playbackRate: audio.playbackRate,
      volume: audio.volume
    };
  });

  return { pageStates, pausedMedia, playingMedia, popupState };
}

function assertClose(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} +/- ${tolerance}, got ${actual}`);
  }
}

function verifyResult(result) {
  const wrongLoadCounts = result.pageStates.filter(page => page.loads !== 2);
  if (wrongLoadCounts.length > 0) {
    throw new Error(`Pages did not reload exactly once: ${JSON.stringify(wrongLoadCounts)}`);
  }
  if (JSON.stringify(result.popupState.tabsByWindow) !== JSON.stringify([25, 25])) {
    throw new Error(`Expected two windows with 25 tabs each, got ${result.popupState.tabsByWindow.join(', ')}`);
  }
  if (result.popupState.progress !== '100%') {
    throw new Error(`Expected 100% progress, got ${result.popupState.progress}`);
  }
  if (result.popupState.history?.successfulTabs !== TAB_COUNT) {
    throw new Error(`Expected ${TAB_COUNT} successful tabs, got ${result.popupState.history?.successfulTabs}`);
  }
  if (result.popupState.history?.failedCount !== 0) {
    throw new Error(`Expected no failures, got ${result.popupState.history?.failedCount}`);
  }
  if ((result.popupState.history?.skippedCount || 0) < 1) {
    throw new Error('Expected the extension control tab to be reported as skipped');
  }

  if (!result.pausedMedia.paused) throw new Error('Paused media resumed unexpectedly');
  assertClose(result.pausedMedia.currentTime, 3, 0.75, 'Paused media timestamp');
  assertClose(result.pausedMedia.volume, 0.35, 0.01, 'Paused media volume');
  assertClose(result.pausedMedia.playbackRate, 1.25, 0.01, 'Paused media playback rate');
  if (result.pausedMedia.muted) throw new Error('Paused media mute state changed');

  if (result.playingMedia.paused) throw new Error('Playing media did not resume');
  if (result.playingMedia.currentTime < 2.5) {
    throw new Error(`Playing media timestamp was not restored: ${result.playingMedia.currentTime}`);
  }
  assertClose(result.playingMedia.volume, 0.45, 0.01, 'Playing media volume');
  assertClose(result.playingMedia.playbackRate, 1.25, 0.01, 'Playing media playback rate');
  if (result.playingMedia.muted) throw new Error('Playing media mute state changed');
}

async function run() {
  console.log(`Starting reliability test with ${TAB_COUNT} tabs across two windows...`);
  const testServer = await createTestServer();
  let browser;

  try {
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
    const extensionId = await findExtensionId(browser);
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(async ({ baseUrl, tabsPerWindow }) => {
      const createWindow = urls => new Promise((resolve, reject) => {
        chrome.windows.create({ focused: false, url: urls }, createdWindow => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(createdWindow.id);
        });
      });
      const firstWindow = Array.from({ length: tabsPerWindow }, (_, index) =>
        index === 0 ? `${baseUrl}/media-paused` : `${baseUrl}/tab-${index}`
      );
      const secondWindow = Array.from({ length: tabsPerWindow }, (_, index) =>
        index === 0 ? `${baseUrl}/media-playing` : `${baseUrl}/tab-${tabsPerWindow + index}`
      );

      await createWindow(firstWindow);
      await createWindow(secondWindow);
    }, { baseUrl: testServer.baseUrl, tabsPerWindow: TABS_PER_WINDOW });

    const pages = await waitForLocalPages(browser, testServer.baseUrl);
    const pausedPage = localPageByPath(pages, '/media-paused');
    const playingPage = localPageByPath(pages, '/media-playing');
    await Promise.all([configureMediaPage(pausedPage), configureMediaPage(playingPage)]);

    await popup.click('#refreshAll');
    await popup.waitForFunction(async expectedSuccesses => {
      const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
      const latest = refreshHistory[0];
      return latest?.successfulTabs === expectedSuccesses
        && latest?.failedCount === 0
        && document.querySelector('#progressFill')?.style.width === '100%';
    }, { timeout: TEST_TIMEOUT_MS }, TAB_COUNT);
    await Promise.all(pages.map(page => page.waitForFunction(
      () => Number(sessionStorage.reliabilityLoads) >= 2,
      { timeout: 10000 }
    )));
    try {
      await Promise.all([
        pausedPage.waitForFunction(() => {
          const audio = document.querySelector('#testAudio');
          return audio?.paused
            && audio.currentTime >= 2.25
            && Math.abs(audio.volume - 0.35) <= 0.01
            && Math.abs(audio.playbackRate - 1.25) <= 0.01;
        }, { timeout: 10000 }),
        playingPage.waitForFunction(() => {
          const audio = document.querySelector('#testAudio');
          return audio
            && !audio.paused
            && audio.currentTime >= 2.5
            && Math.abs(audio.volume - 0.45) <= 0.01
            && Math.abs(audio.playbackRate - 1.25) <= 0.01;
        }, { timeout: 10000 })
      ]);
    } catch (error) {
      const states = await Promise.all([pausedPage, playingPage].map(page => page.evaluate(() => {
        const audio = document.querySelector('#testAudio');
        return {
          currentTime: audio?.currentTime,
          paused: audio?.paused,
          playbackRate: audio?.playbackRate,
          volume: audio?.volume
        };
      })));
      throw new Error(`Restored media state did not settle: ${JSON.stringify(states)}`);
    }

    const result = await collectResult(popup, pages, testServer.baseUrl);
    verifyResult(result);
    console.log(`PASS: ${TAB_COUNT} tabs reloaded exactly once in two windows.`);
    console.log('PASS: paused and playing media state was restored.');
    console.log(`PASS: ${result.popupState.status}`);
  } finally {
    if (browser) await browser.close();
    await testServer.close();
  }
}

run().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
