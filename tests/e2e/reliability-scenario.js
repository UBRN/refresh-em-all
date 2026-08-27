const path = require('path');

const {
  captureFailureDiagnostics,
  createPhaseTimer,
  prepareOutputDirectory,
  runPool,
  waitForCondition,
  writeJson
} = require('./harness');

const PROFILES = {
  smoke: {
    tabCount: 8,
    tabsPerWindow: 4,
    operationTimeout: 30000
  },
  medium: {
    tabCount: 20,
    tabsPerWindow: 10,
    operationTimeout: 60000
  },
  full: {
    tabCount: 50,
    tabsPerWindow: 25,
    operationTimeout: 120000
  }
};

function localPageByPath(pages, pathname) {
  const page = pages.find(candidate => new URL(candidate.url()).pathname === pathname);
  if (!page) throw new Error(`Could not find test page ${pathname}`);
  return page;
}

async function createWindow(controlPage, url) {
  return controlPage.evaluate(initialUrl => new Promise((resolve, reject) => {
    chrome.windows.create({ focused: false, url: initialUrl }, createdWindow => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(createdWindow.id);
    });
  }), url);
}

async function createTab(controlPage, windowId, url) {
  return controlPage.evaluate(({ targetWindowId, targetUrl }) => new Promise((resolve, reject) => {
    chrome.tabs.create({ active: false, windowId: targetWindowId, url: targetUrl }, createdTab => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(createdTab.id);
    });
  }), { targetWindowId: windowId, targetUrl: url });
}

async function createTabFixture(harness, config, timer) {
  const firstUrls = [
    `${harness.baseUrl}/media-paused`,
    `${harness.baseUrl}/media-playing`
  ];
  const windowIds = await timer.measure('windowCreation', () =>
    Promise.all(firstUrls.map(url => createWindow(harness.controlPage, url))));

  const tabTasks = [];
  for (let windowIndex = 0; windowIndex < windowIds.length; windowIndex++) {
    for (let index = 1; index < config.tabsPerWindow; index++) {
      tabTasks.push({
        windowId: windowIds[windowIndex],
        url: `${harness.baseUrl}/tab-${windowIndex * config.tabsPerWindow + index}`
      });
    }
  }

  await timer.measure('tabCreation', () =>
    runPool(tabTasks, 4, task => createTab(harness.controlPage, task.windowId, task.url)));

  return windowIds;
}

async function waitForFixturePages(harness, config, timer) {
  return timer.measure('pageReadiness', async () => {
    const pages = await waitForCondition(async () => {
      const browserPages = await harness.browser.pages();
      const localPages = browserPages.filter(page => page.url().startsWith(harness.baseUrl));
      return localPages.length === config.tabCount ? localPages : null;
    }, {
      timeout: 30000,
      description: `${config.tabCount} localhost tabs`
    });

    pages.forEach((page, index) => harness.attachPage(page, `reliability-${index + 1}`));
    await runPool(pages, 8, page => page.waitForFunction(
      () => window.reliabilityReady === true,
      { timeout: 10000 }
    ));
    return pages;
  });
}

async function collectPageStates(pages) {
  return runPool(pages, 8, async page => ({
    pathname: new URL(page.url()).pathname,
    loads: await page.evaluate(() => Number(sessionStorage.reliabilityLoads)),
    ready: await page.evaluate(() => window.reliabilityReady === true)
  }));
}

async function collectTopology(popup, baseUrl) {
  return popup.evaluate(async expectedBaseUrl => {
    const tabs = await chrome.tabs.query({});
    const localTabs = tabs.filter(tab => tab.url?.startsWith(expectedBaseUrl));
    const tabsByWindow = localTabs.reduce((result, tab) => {
      result[tab.windowId] = (result[tab.windowId] || 0) + 1;
      return result;
    }, {});

    return {
      localUrls: localTabs.map(tab => tab.url).sort(),
      queriedTabCount: tabs.length,
      tabsByWindow: Object.values(tabsByWindow).sort((left, right) => left - right)
    };
  }, baseUrl);
}

function verifyBatchRange(profile, queriedTabCount) {
  if (profile === 'smoke' && queriedTabCount > 20) {
    throw new Error(`Smoke profile unexpectedly queried ${queriedTabCount} tabs`);
  }
  if (profile === 'medium' && (queriedTabCount <= 20 || queriedTabCount > 50)) {
    throw new Error(`Medium profile must exercise the >20 tab branch; queried ${queriedTabCount}`);
  }
  if (profile === 'full' && queriedTabCount <= 50) {
    throw new Error(`Full profile must exercise the >50 tab branch; queried ${queriedTabCount}`);
  }
}

async function validateFixture(popup, pages, baseUrl, profile, config) {
  const [pageStates, topology] = await Promise.all([
    collectPageStates(pages),
    collectTopology(popup, baseUrl)
  ]);
  const wrongInitialLoads = pageStates.filter(page => page.loads !== 1 || !page.ready);
  if (wrongInitialLoads.length > 0) {
    throw new Error(`Fixture pages were not ready exactly once: ${JSON.stringify(wrongInitialLoads)}`);
  }
  const expectedWindows = [config.tabsPerWindow, config.tabsPerWindow];
  if (JSON.stringify(topology.tabsByWindow) !== JSON.stringify(expectedWindows)) {
    throw new Error(`Expected two windows with ${config.tabsPerWindow} tabs, got ${topology.tabsByWindow.join(', ')}`);
  }
  if (new Set(topology.localUrls).size !== config.tabCount) {
    throw new Error('Fixture contains missing or duplicate local URLs');
  }
  verifyBatchRange(profile, topology.queriedTabCount);
  return { pageStates, topology };
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

async function armRefreshCompletion(popup, timeout) {
  await popup.evaluate(completionTimeout => {
    window.__reliabilityRefreshComplete = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(`refreshComplete message was not received within ${completionTimeout}ms`));
      }, completionTimeout);
      function listener(message) {
        if (message.action !== 'refreshComplete') return;
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message);
      }
      chrome.runtime.onMessage.addListener(listener);
    });
  }, timeout);
}

async function waitForRefreshCompletion(popup, config) {
  try {
    return await popup.evaluate(() => window.__reliabilityRefreshComplete);
  } catch (messageError) {
    try {
      await popup.waitForFunction(async expectedSuccesses => {
        const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
        const latest = refreshHistory[0];
        return latest?.successfulTabs === expectedSuccesses
          && latest?.failedCount === 0
          && document.querySelector('#progressFill')?.style.width === '100%';
      }, { timeout: 5000 }, config.tabCount);
      return { action: 'refreshComplete', diagnosticFallback: true };
    } catch (fallbackError) {
      throw new Error(`${messageError.message}; storage/UI fallback also failed: ${fallbackError.message}`);
    }
  }
}

async function waitForMediaRestoration(pausedPage, playingPage) {
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
        muted: audio?.muted,
        paused: audio?.paused,
        playbackRate: audio?.playbackRate,
        volume: audio?.volume
      };
    })));
    throw new Error(`Restored media state did not settle: ${JSON.stringify(states)}`);
  }
}

async function collectResult(popup, pages, baseUrl) {
  const pageStates = await collectPageStates(pages);
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

function verifyResult(result, config) {
  const wrongLoadCounts = result.pageStates.filter(page => page.loads !== 2);
  if (wrongLoadCounts.length > 0) {
    throw new Error(`Pages did not reload exactly once: ${JSON.stringify(wrongLoadCounts)}`);
  }
  const expectedWindows = [config.tabsPerWindow, config.tabsPerWindow];
  if (JSON.stringify(result.popupState.tabsByWindow) !== JSON.stringify(expectedWindows)) {
    throw new Error(`Expected two windows with ${config.tabsPerWindow} tabs, got ${result.popupState.tabsByWindow.join(', ')}`);
  }
  if (result.popupState.progress !== '100%') {
    throw new Error(`Expected 100% progress, got ${result.popupState.progress}`);
  }
  if (result.popupState.history?.successfulTabs !== config.tabCount) {
    throw new Error(`Expected ${config.tabCount} successful tabs, got ${result.popupState.history?.successfulTabs}`);
  }
  if (result.popupState.history?.failedCount !== 0) {
    throw new Error(`Expected no failures, got ${result.popupState.history?.failedCount}`);
  }
  if ((result.popupState.history?.skippedCount || 0) < 1) {
    throw new Error('Expected extension control tabs to be reported as skipped');
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

async function runDeniedPathScenario(harness, { closeHarness = false } = {}) {
  const config = { tabCount: 2, tabsPerWindow: 1, operationTimeout: 30000 };
  const popup = harness.controlPage;
  let windowIds = [];
  let pages = [];

  try {
    await harness.resetState();
    windowIds = await createTabFixture(harness, config, {
      measure: (name, operation) => operation()
    });
    pages = await waitForFixturePages(harness, config, {
      measure: (name, operation) => operation()
    });
    await validateFixture(popup, pages, harness.baseUrl, 'smoke', config);

    const pausedPage = localPageByPath(pages, '/media-paused');
    const playingPage = localPageByPath(pages, '/media-playing');
    await Promise.all([configureMediaPage(pausedPage), configureMediaPage(playingPage)]);

    const origins = await popup.evaluate(async () => {
      await chrome.storage.local.set({ mediaAccessAsked: true });
      return (await chrome.permissions.getAll()).origins || [];
    });
    if (origins.includes('<all_urls>')) {
      throw new Error(`Denied-path profile unexpectedly has site access: ${JSON.stringify(origins)}`);
    }
    await popup.reload({ waitUntil: 'load' });

    await armRefreshCompletion(popup, config.operationTimeout);
    // The popup keeps this control disabled until it has resolved site access and
    // any restored operation. Clicking before that fires no event at all.
    await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
    await popup.click('#refreshAll');
    await waitForRefreshCompletion(popup, config);
    await runPool(pages, 2, page => page.waitForFunction(
      () => Number(sessionStorage.reliabilityLoads) >= 2,
      { timeout: 10000 }
    ));

    const result = await collectResult(popup, pages, harness.baseUrl);
    const wrongLoadCounts = result.pageStates.filter(page => page.loads !== 2);
    if (wrongLoadCounts.length > 0) {
      throw new Error(`Denied-path pages did not reload exactly once: ${JSON.stringify(wrongLoadCounts)}`);
    }
    if (result.popupState.history?.successfulTabs !== config.tabCount
        || result.popupState.history?.failedCount !== 0) {
      throw new Error(`Denied-path refresh reported errors: ${JSON.stringify(result.popupState.history)}`);
    }
    if (result.popupState.progress !== '100%') {
      throw new Error(`Denied-path progress did not complete: ${result.popupState.progress}`);
    }

    const pausedWasRestored = result.pausedMedia.currentTime >= 2.25
      && Math.abs(result.pausedMedia.volume - 0.35) <= 0.01
      && Math.abs(result.pausedMedia.playbackRate - 1.25) <= 0.01;
    const playingWasRestored = !result.playingMedia.paused
      && result.playingMedia.currentTime >= 2.5
      && Math.abs(result.playingMedia.volume - 0.45) <= 0.01
      && Math.abs(result.playingMedia.playbackRate - 1.25) <= 0.01;
    if (pausedWasRestored || playingWasRestored) {
      throw new Error(`Denied-path media state was restored: ${JSON.stringify({
        pausedMedia: result.pausedMedia,
        playingMedia: result.playingMedia
      })}`);
    }

    return result;
  } catch (error) {
    await captureFailureDiagnostics({
      profile: 'denied',
      error,
      popup,
      pages,
      diagnostics: harness.diagnostics
    });
    throw error;
  } finally {
    if (windowIds.length > 0) await harness.removeWindows(windowIds);
    if (closeHarness) await harness.close();
  }
}

async function runReliabilityScenario(harness, profile, {
  closeHarness = false,
  reusedBrowser = false
} = {}) {
  const config = PROFILES[profile];
  if (!config) throw new Error(`Unknown reliability profile: ${profile}`);

  const basePhases = reusedBrowser
    ? { serverSetup: 0, browserLaunch: 0, extensionDiscovery: 0 }
    : harness.basePhases;
  const timer = createPhaseTimer(
    profile,
    basePhases,
    reusedBrowser ? performance.now() : harness.startedAt
  );
  const outputDirectory = prepareOutputDirectory(profile);
  const popup = harness.controlPage;
  let windowIds = [];
  let pages = [];
  let fixtureState;
  let result;
  let failure;

  console.log(`Starting ${profile} reliability profile with ${config.tabCount} tabs across two windows...`);

  try {
    await timer.measure('stateReset', () => harness.resetState());
    windowIds = await createTabFixture(harness, config, timer);
    pages = await waitForFixturePages(harness, config, timer);
    fixtureState = await timer.measure('fixtureValidation', () =>
      validateFixture(popup, pages, harness.baseUrl, profile, config));

    const pausedPage = localPageByPath(pages, '/media-paused');
    const playingPage = localPageByPath(pages, '/media-playing');
    await timer.measure('mediaSetup', () =>
      Promise.all([configureMediaPage(pausedPage), configureMediaPage(playingPage)]));

    await timer.measure('traceSetup', () => harness.startTrace(popup));
    await timer.measure('extensionOperation', async () => {
      await armRefreshCompletion(popup, config.operationTimeout);
      // The popup keeps this control disabled until it has resolved site access and
      // any restored operation. Clicking before that fires no event at all.
      await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
      await popup.click('#refreshAll');
      await waitForRefreshCompletion(popup, config);
    });

    await timer.measure('postRefreshChecks', async () => {
      await runPool(pages, 8, page => page.waitForFunction(
        () => Number(sessionStorage.reliabilityLoads) >= 2,
        { timeout: 10000 }
      ));
      await waitForMediaRestoration(pausedPage, playingPage);
      result = await collectResult(popup, pages, harness.baseUrl);
    });
    await timer.measure('assertions', async () => verifyResult(result, config));
    await timer.measure('traceFinalization', () => harness.stopTrace({ keep: false }));

    console.log(`PASS: ${config.tabCount} tabs reloaded exactly once in two windows.`);
    console.log('PASS: paused and playing media state was restored.');
    console.log(`PASS: ${result.popupState.status}`);
  } catch (error) {
    failure = error;
    await timer.measure('traceFinalization', () => harness.stopTrace({ keep: true }));
    await timer.measure('diagnostics', () => captureFailureDiagnostics({
      profile,
      error,
      popup,
      pages,
      diagnostics: harness.diagnostics,
      additionalState: { fixtureState, result }
    }));
  } finally {
    const cleanupStarted = performance.now();
    if (windowIds.length > 0) await harness.removeWindows(windowIds);
    if (closeHarness) await harness.close();
    timer.set('cleanup', performance.now() - cleanupStarted);
    writeJson(path.join(outputDirectory, 'timings.json'), timer.snapshot(
      failure ? 'failed' : 'passed',
      {
        tabCount: config.tabCount,
        tabsPerWindow: config.tabsPerWindow,
        queriedTabCount: fixtureState?.topology?.queriedTabCount,
        reusedBrowser
      }
    ));
  }

  if (failure) throw failure;
  return { config, fixtureState, result };
}

module.exports = { PROFILES, runDeniedPathScenario, runReliabilityScenario };
