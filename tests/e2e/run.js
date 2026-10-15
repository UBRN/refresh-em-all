const path = require('path');

const {
  captureFailureDiagnostics,
  createHarness,
  createPhaseTimer,
  runPool,
  ensureOutputDirectory,
  writeJson
} = require('./harness');
const { runDeniedPathScenario, runReliabilityScenario } = require('./reliability-scenario');

const TEST_CASES = [
  {
    name: 'reloads real pages and reports skipped pages separately',
    run: async (harness, testName) => {
      const pageA = harness.attachPage(await harness.browser.newPage(), 'essential-page-a');
      const pageB = harness.attachPage(await harness.browser.newPage(), 'essential-page-b');
      const popup = harness.attachPage(await harness.browser.newPage(), 'essential-refresh-popup');
      const popupErrors = [];
      popup.on('pageerror', error => popupErrors.push(error.message));

      try {
        await Promise.all([
          pageA.goto(`${harness.baseUrl}/a`),
          pageB.goto(`${harness.baseUrl}/b`)
        ]);
        await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
        // The popup keeps this control disabled until it has resolved site access and
        // any restored operation. Clicking before that fires no event at all.
        await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
        await popup.click('#refreshAll');
        await popup.waitForFunction(async () => {
          if (!['done', 'failed'].includes(document.body.dataset.state)) return false;
          const status = document.body.dataset.state === 'done'
            ? document.querySelector('#doneTitle')?.textContent
            : document.querySelector('#failTitle')?.textContent;
          const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
          const latest = refreshHistory[0];
          if (!latest || latest.cancelled) return false;

          const key = latest.failedCount > 0
            ? (latest.failedCount === 1 ? 'errorFailedSummaryOne' : 'errorFailedSummaryOther')
            : latest.skippedCount > 0
              ? 'statusCompleteSkipped'
              : 'statusCompleteAll';
          const substitutions = latest.failedCount > 0
            ? [latest.failedCount]
            : key === 'statusCompleteSkipped'
              ? [latest.successfulTabs, latest.skippedCount]
              : [latest.successfulTabs];
          return status === chrome.i18n.getMessage(key, substitutions.map(String));
        }, { timeout: 15000 });

        await Promise.all([
          pageA.waitForFunction(() => Number(sessionStorage.refreshAuditLoads) >= 2, { timeout: 5000 }),
          pageB.waitForFunction(() => Number(sessionStorage.refreshAuditLoads) >= 2, { timeout: 5000 })
        ]);
        await popup.waitForFunction(async () => {
          const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
          return refreshHistory.length > 0;
        }, { timeout: 5000 });

        const [loadsA, loadsB, popupState] = await Promise.all([
          pageA.evaluate(() => Number(sessionStorage.refreshAuditLoads)),
          pageB.evaluate(() => Number(sessionStorage.refreshAuditLoads)),
          popup.evaluate(async () => {
            const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
            const latestHistory = refreshHistory[0];
            return {
              status: document.querySelector('#doneTitle')?.textContent || '',
              expectedStatus: chrome.i18n.getMessage('statusCompleteSkipped', [
                String(latestHistory?.successfulTabs || 0),
                String(latestHistory?.skippedCount || 0)
              ]),
              progress: document.querySelector('#progressBar')?.getAttribute('aria-valuenow') || '',
              successIndicators: document.querySelectorAll('#tabDots .dot[data-status="success"]').length,
              skippedIndicators: document.querySelectorAll('#tabDots .dot[data-status="skipped"]').length,
              latestHistory
            };
          })
        ]);

        if (loadsA !== 2 || loadsB !== 2) throw new Error('One or more real pages did not reload exactly once');
        if (popupState.progress !== '100') throw new Error(`Expected 100% progress, got ${popupState.progress}`);
        if (popupState.status !== popupState.expectedStatus) throw new Error(`Skipped pages were not reported: ${popupState.status}`);
        if (popupState.successIndicators !== 2) throw new Error(`Expected 2 success indicators, got ${popupState.successIndicators}`);
        if (popupState.skippedIndicators < 1) throw new Error('Expected at least one skipped indicator');
        if (popupState.latestHistory?.successfulTabs !== 2) throw new Error('Sanitized local history has the wrong success count');
        if (popupErrors.length > 0) throw new Error(`Popup errors: ${popupErrors.join('; ')}`);
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, popup, [pageA, pageB]);
        throw error;
      } finally {
        await Promise.all([pageA.close(), pageB.close(), popup.close()]);
      }
    }
  },
  {
    name: 'fetches a fresh file instead of reusing a long-lived saved copy',
    run: async (harness, testName) => {
      const page = harness.attachPage(await harness.browser.newPage(), 'cache-bypass-page');
      const popup = harness.attachPage(await harness.browser.newPage(), 'cache-bypass-popup');

      try {
        await page.goto(`${harness.baseUrl}/cache-bypass`);
        await page.waitForFunction(() =>
          window.reliabilityReady === true && window.cacheProbeGeneration === 1,
        { timeout: 10000 });
        if (harness.cacheProbeRequestCount() !== 1) {
          throw new Error(`Expected one initial cache-probe request, got ${harness.cacheProbeRequestCount()}`);
        }

        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() =>
          Number(sessionStorage.refreshAuditLoads) === 2 && window.cacheProbeGeneration === 1,
        { timeout: 10000 });
        if (harness.cacheProbeRequestCount() !== 1) {
          throw new Error(`Normal reload unexpectedly bypassed the cache probe: ${harness.cacheProbeRequestCount()} requests`);
        }

        await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
        // The popup keeps this control disabled until it has resolved site access and
        // any restored operation. Clicking before that fires no event at all.
        await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
        await popup.click('#refreshAll');
        await page.waitForFunction(() =>
          Number(sessionStorage.refreshAuditLoads) === 3 && window.cacheProbeGeneration === 2,
        { timeout: 15000 });
        await popup.waitForFunction(async () => {
          const { refreshHistory = [] } = await chrome.storage.local.get(['refreshHistory']);
          return refreshHistory[0]?.successfulTabs === 1;
        }, { timeout: 15000 });

        const state = await page.evaluate(() => ({
          generation: window.cacheProbeGeneration,
          loads: Number(sessionStorage.refreshAuditLoads)
        }));
        const requestCount = harness.cacheProbeRequestCount();
        if (requestCount !== 2 || state.generation !== 2 || state.loads !== 3) {
          throw new Error(`Fresh-file probe failed: ${JSON.stringify({ requestCount, ...state })}`);
        }
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, popup, [page]);
        throw error;
      } finally {
        await Promise.all([page.close(), popup.close()]);
      }
    }
  },
  {
    name: 'reloads only the active tab from the toolbar popup',
    run: async (harness, testName) => {
      const pageA = harness.attachPage(await harness.browser.newPage(), 'single-tab-page-a');
      const pageB = harness.attachPage(await harness.browser.newPage(), 'single-tab-page-b');
      let popup;

      try {
        await Promise.all([
          pageA.goto(`${harness.baseUrl}/a`),
          pageB.goto(`${harness.baseUrl}/b`)
        ]);
        await pageB.bringToFront();
        // The real popup, not popup.html in a tab: only there is the page the user
        // looks at the active tab of the current window.
        popup = await openToolbarPopup(harness);
        await popup.waitForSelector('#refreshThisTab:not([disabled]):not([aria-disabled="true"])', { timeout: 15000 });
        const site = await popup.$eval('#thisTabSite', element => element.textContent);
        if (site !== new URL(harness.baseUrl).hostname) throw new Error(`This-tab action names ${site}`);

        // Chrome closes the popup as soon as the tab under it reloads; the toolbar
        // badge carries the result instead.
        await popup.click('#refreshThisTab');
        await pageB.waitForFunction(() => Number(sessionStorage.refreshAuditLoads) >= 2, { timeout: 15000 });
        const badge = await waitForBadge(harness, text => text === '\u2713');

        const [loadsA, loadsB, latest] = await Promise.all([
          pageA.evaluate(() => Number(sessionStorage.refreshAuditLoads)),
          pageB.evaluate(() => Number(sessionStorage.refreshAuditLoads)),
          harness.controlPage.evaluate(async () => (await chrome.storage.local.get(['refreshHistory'])).refreshHistory?.[0])
        ]);
        if (badge !== '\u2713') throw new Error(`Unexpected toolbar badge: ${badge}`);
        if (loadsB !== 2) throw new Error(`The active tab loaded ${loadsB} times`);
        if (loadsA !== 1) throw new Error(`A background tab reloaded: ${loadsA} loads`);
        if (!latest?.singleTab || latest.totalTabs !== 1 || latest.successfulTabs !== 1) {
          throw new Error(`Unexpected history entry: ${JSON.stringify(latest)}`);
        }
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, harness.controlPage, [pageA, pageB]);
        throw error;
      } finally {
        await popup?.close().catch(() => {});
        await Promise.all([pageA.close(), pageB.close()]);
      }
    }
  },
  {
    name: 'reloads the tab under the toolbar popup last and shows the result on the badge',
    run: async (harness, testName) => {
      const pages = await Promise.all(['/a', '/b', '/c'].map(async (pathname, index) => {
        const page = harness.attachPage(await harness.browser.newPage(), `active-last-${index}`);
        await page.goto(`${harness.baseUrl}${pathname}`);
        return page;
      }));
      let popup;

      try {
        await pages[0].bringToFront();
        popup = await openToolbarPopup(harness);
        await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
        await popup.click('#refreshAll');
        await runPool(pages, 3, page => page.waitForFunction(
          () => Number(sessionStorage.refreshAuditLoads) >= 2,
          { timeout: 15000 }
        ));
        const badge = await waitForBadge(harness, text => text === '\u2713');
        const loadedAt = await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));

        if (badge !== '\u2713') throw new Error(`Unexpected toolbar badge: ${badge}`);
        if (!(loadedAt[0] > loadedAt[1] && loadedAt[0] > loadedAt[2])) {
          throw new Error(`The active tab did not reload last: ${JSON.stringify(loadedAt)}`);
        }
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, harness.controlPage, pages);
        throw error;
      } finally {
        await popup?.close().catch(() => {});
        await Promise.all(pages.map(page => page.close()));
      }
    }
  },
  {
    name: 'leaves a tab with unsaved text alone and puts a sleeping tab back to sleep',
    run: async (harness, testName) => {
      const draft = harness.attachPage(await harness.browser.newPage(), 'unsaved-draft');
      const sleeper = harness.attachPage(await harness.browser.newPage(), 'sleeping-tab');
      const popup = harness.attachPage(await harness.browser.newPage(), 'unsaved-popup');

      try {
        await Promise.all([
          draft.goto(`${harness.baseUrl}/a`),
          sleeper.goto(`${harness.baseUrl}/b`)
        ]);
        await draft.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<textarea id="draft"></textarea>'));
        await draft.type('#draft', 'half typed');
        await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
        const sleeperId = await popup.evaluate(async url => {
          const [tab] = await chrome.tabs.query({ url });
          await chrome.tabs.discard(tab.id);
          return tab.id;
        }, `${harness.baseUrl}/b`);

        await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
        await popup.click('#refreshAll');
        await popup.waitForFunction(() => document.body.dataset.state === 'done', { timeout: 15000 });
        const doneSub = await popup.$eval('#doneSub', element => element.textContent);
        const expected = await popup.evaluate(() => chrome.i18n.getMessage('doneSubUnsaved'));
        if (doneSub !== expected) throw new Error(`Unexpected result line: ${doneSub}`);

        const [loads, text] = await draft.evaluate(() => [Number(sessionStorage.refreshAuditLoads), document.querySelector('#draft').value]);
        if (loads !== 1 || text !== 'half typed') throw new Error(`The draft tab reloaded: ${loads} loads, text "${text}"`);

        // Woken to reload, then asleep again once its fresh files are in.
        await popup.waitForFunction(async id => {
          const tab = await chrome.tabs.get(id);
          return tab.discarded === true;
        }, { timeout: 15000 }, sleeperId);
        const latest = await popup.evaluate(async () => (await chrome.storage.local.get(['refreshHistory'])).refreshHistory?.[0]);
        if (!latest || latest.skippedCount < 1 || latest.successfulTabs < 1) {
          throw new Error(`Unexpected history entry: ${JSON.stringify(latest)}`);
        }
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, popup, [draft]);
        throw error;
      } finally {
        await Promise.all([draft.close(), sleeper.close(), popup.close()].map(closing => closing.catch(() => {})));
      }
    }
  },
  {
    name: 'shows an accurate local-only privacy statement',
    run: async (harness, testName) => {
      const popup = harness.attachPage(await harness.browser.newPage(), 'essential-privacy-popup');
      try {
        await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
        await popup.waitForSelector('#openSettings');
        await popup.click('#openSettings');
        const state = await popup.evaluate(async () => {
          const { pendingErrorReports } = await chrome.storage.local.get(['pendingErrorReports']);
          const notice = document.querySelector('#privacyNotice')?.textContent || '';
          return {
            privacyMatches: notice === chrome.i18n.getMessage('privacyNotice'),
            hasTelemetryToggle: Boolean(document.querySelector('#errorReportingToggle')),
            hasPendingReports: Array.isArray(pendingErrorReports) && pendingErrorReports.length > 0
          };
        });

        if (!state.privacyMatches) throw new Error('Local-only privacy statement is missing');
        if (state.hasTelemetryToggle || state.hasPendingReports) throw new Error('Legacy telemetry state is still exposed');
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, popup);
        throw error;
      } finally {
        await popup.close();
      }
    }
  },
  {
    name: 'renders sanitized refresh history independently',
    run: async (harness, testName) => {
      await harness.controlPage.evaluate(async history => {
        await chrome.storage.local.set({ refreshHistory: [history] });
      }, {
        timestamp: new Date().toISOString(),
        totalTabs: 2,
        successfulTabs: 2,
        failedCount: 0,
        skippedCount: 1,
        cancelled: false
      });

      const popup = harness.attachPage(await harness.browser.newPage(), 'essential-history-popup');
      try {
        await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
        const seeded = await popup.waitForFunction(() => {
          const meta = document.querySelector('#metaHistory')?.textContent || '';
          return meta !== '' && meta !== chrome.i18n.getMessage('historyEmpty');
        }, { timeout: 5000 }).then(() => true, () => false);
        if (!seeded) throw new Error('Seeded history did not appear');

        await popup.click('#openHistory');
        const historyState = await popup.evaluate(() => {
          const row = document.querySelector('#historyList li');
          return {
            summaryMatches: row?.querySelector('b')?.textContent
              === chrome.i18n.getMessage('historyEntryReloaded', ['2', '2'])
              && row?.querySelector('.sub2')?.textContent
              === chrome.i18n.getMessage('historyEntryDetail', ['0', '1']),
            hasMarkupInjection: Boolean(document.querySelector('#historyList script'))
          };
        });
        if (!historyState.summaryMatches) throw new Error('History summary is missing');
        if (historyState.hasMarkupInjection) throw new Error('Unexpected executable markup in history');
      } catch (error) {
        await captureEssentialFailure(harness, testName, error, popup);
        throw error;
      } finally {
        await popup.close();
      }
    }
  }
];

function phaseName(testName) {
  return `essential:${testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function diagnosticProfile(testName) {
  return path.join('fast', phaseName(testName).slice('essential:'.length));
}

async function captureEssentialFailure(harness, name, error, popup, pages = []) {
  try {
    await captureFailureDiagnostics({
      profile: diagnosticProfile(name),
      error,
      popup,
      pages,
      diagnostics: harness.diagnostics,
      additionalState: { testCase: name }
    });
  } catch (diagnosticError) {
    error.diagnosticCaptureError = diagnosticError.message;
    console.error(`  Diagnostic capture also failed: ${diagnosticError.message}`);
  }
  error.essentialDiagnosticsCaptured = true;
}

async function extensionWorker(harness) {
  const workerTarget = await harness.browser.waitForTarget(
    target => target.type() === 'service_worker' && target.url().startsWith(`chrome-extension://${harness.extensionId}/`),
    { timeout: 15000 }
  );
  return workerTarget.worker();
}

async function waitForBadge(harness, accept) {
  const worker = await extensionWorker(harness);
  const deadline = Date.now() + 10000;
  let text = '';
  while (Date.now() < deadline) {
    text = await worker.evaluate('chrome.action.getBadgeText({})');
    if (accept(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return text;
}

async function openToolbarPopup(harness) {
  const worker = await extensionWorker(harness);
  const controlTarget = harness.controlPage.target();
  await worker.evaluate('chrome.action.openPopup()');
  const popupTarget = await harness.browser.waitForTarget(
    target => target !== controlTarget && target.url().endsWith('/popup.html'),
    { timeout: 15000 }
  );
  return harness.attachPage(await popupTarget.asPage(), 'toolbar-popup');
}

// A fresh profile without page access: the first refresh explains the permission in
// the popup and starts nothing until the user answers. "Just refresh" reloads without
// opening Chrome's dialog, which automation could not dismiss, and is remembered.
async function runFirstRunScenario(harness) {
  const page = harness.attachPage(await harness.browser.newPage(), 'first-run-page');
  const popup = harness.attachPage(await harness.browser.newPage(), 'first-run-popup');
  try {
    await harness.resetState();
    await page.goto(`${harness.baseUrl}/a`);
    await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });

    await popup.click('#refreshAll');
    await popup.waitForFunction(() => document.body.dataset.state === 'ask', { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const beforeAnswer = await Promise.all([
      page.evaluate(() => Number(sessionStorage.refreshAuditLoads)),
      popup.evaluate(async () => ({
        history: (await chrome.storage.local.get(['refreshHistory'])).refreshHistory || [],
        origins: (await chrome.permissions.getAll()).origins || []
      }))
    ]);
    if (beforeAnswer[0] !== 1) throw new Error('The page reloaded before the first-run question was answered');
    if (beforeAnswer[1].history.length > 0) throw new Error('A run started before the question was answered');
    if (beforeAnswer[1].origins.includes('<all_urls>')) throw new Error('Page access was granted without asking');

    await popup.click('#justRefresh');
    await page.waitForFunction(() => Number(sessionStorage.refreshAuditLoads) === 2, { timeout: 15000 });
    await popup.waitForFunction(() => document.body.dataset.state === 'done', { timeout: 15000 });
    const asked = await popup.evaluate(async () => (await chrome.storage.local.get(['mediaAccessAsked'])).mediaAccessAsked);
    if (asked !== true) throw new Error('The first-run answer was not remembered');

    await popup.reload({ waitUntil: 'load' });
    await popup.waitForSelector('#refreshAll:not([disabled])', { timeout: 15000 });
    await popup.click('#refreshAll');
    await page.waitForFunction(() => Number(sessionStorage.refreshAuditLoads) === 3, { timeout: 15000 });
    const askedAgain = await popup.evaluate(() => document.body.dataset.state === 'ask');
    if (askedAgain) throw new Error('The popup asked again after the first answer');
    await popup.waitForFunction(() => document.body.dataset.state === 'done', { timeout: 15000 });
  } catch (error) {
    await captureEssentialFailure(harness, 'first run asks in the popup', error, popup, [page]);
    throw error;
  } finally {
    await Promise.all([page.close(), popup.close()]);
  }
}

async function runTests() {
  console.log('Starting fast end-to-end suite...');
  let failed = 0;

  const deniedHarness = await createHarness({
    profile: 'denied',
    trace: false,
    seedSiteAccess: false
  });
  process.stdout.write('Running test: first refresh asks in the popup before Chrome does... ');
  try {
    await runFirstRunScenario(deniedHarness);
    console.log('PASS');
  } catch (error) {
    failed++;
    console.log('FAIL');
    console.error(`  ${error.message}`);
  }

  process.stdout.write('Running test: reloads without optional page-reading permission and does not restore media... ');
  try {
    await runDeniedPathScenario(deniedHarness, { closeHarness: true });
    console.log('PASS');
  } catch (error) {
    failed++;
    console.log('FAIL');
    console.error(`  ${error.message}`);
  }

  const harness = await createHarness({ profile: 'fast', trace: false });
  const timer = createPhaseTimer('fast', harness.basePhases, harness.startedAt);
  const outputDirectory = ensureOutputDirectory('fast');
  let harnessClosed = false;

  try {
    for (const testCase of TEST_CASES) {
      process.stdout.write(`Running test: ${testCase.name}... `);
      await harness.resetState();
      try {
        await timer.measure(phaseName(testCase.name), () => testCase.run(harness, testCase.name));
        console.log('PASS');
      } catch (error) {
        failed++;
        console.log('FAIL');
        console.error(`  ${error.message}`);
        if (!error.essentialDiagnosticsCaptured) {
          await captureFailureDiagnostics({
            profile: diagnosticProfile(testCase.name),
            error,
            popup: harness.controlPage,
            diagnostics: harness.diagnostics,
            additionalState: { testCase: testCase.name }
          });
        }
      }
    }

    process.stdout.write('Running test: 8-tab two-window reliability smoke... ');
    try {
      await timer.measure('reliability:smoke', () =>
        runReliabilityScenario(harness, 'smoke', {
          closeHarness: true,
          reusedBrowser: true
        }));
      harnessClosed = true;
      console.log('PASS');
    } catch (error) {
      harnessClosed = true;
      failed++;
      console.log('FAIL');
      console.error(`  ${error.message}`);
    }
  } finally {
    if (!harnessClosed) await harness.close();
    writeJson(path.join(outputDirectory, 'timings.json'), timer.snapshot(
      failed === 0 ? 'passed' : 'failed',
      { essentialTests: TEST_CASES.length + 1, includesSmoke: true }
    ));
  }

  console.log(`Fast suite summary: ${TEST_CASES.length + 3 - failed} passed, ${failed} failed`);
  return failed === 0;
}

runTests()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
