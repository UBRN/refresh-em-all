const path = require('path');

const {
  captureFailureDiagnostics,
  createHarness,
  createPhaseTimer,
  ensureOutputDirectory,
  writeJson
} = require('./harness');
const { runReliabilityScenario } = require('./reliability-scenario');

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
        await popup.click('#refreshAll');
        await popup.waitForFunction(() => {
          const status = document.querySelector('#statusText')?.textContent || '';
          return status.includes('successfully')
            || status.includes('restricted tabs')
            || status.includes('failed');
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
            return {
              status: document.querySelector('#statusText')?.textContent || '',
              progress: document.querySelector('#progressFill')?.style.width || '',
              successIndicators: document.querySelectorAll('.tab-success[style*="display: block"]').length,
              skippedIndicators: document.querySelectorAll('.tab-skipped[style*="display: block"]').length,
              latestHistory: refreshHistory[0]
            };
          })
        ]);

        if (loadsA !== 2 || loadsB !== 2) throw new Error('One or more real pages did not reload exactly once');
        if (popupState.progress !== '100%') throw new Error(`Expected 100% progress, got ${popupState.progress}`);
        if (!popupState.status.includes('skipped')) throw new Error(`Skipped pages were not reported: ${popupState.status}`);
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
    name: 'bypasses local cache for a long-lived cacheable resource',
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
          throw new Error(`Cache-bypass probe failed: ${JSON.stringify({ requestCount, ...state })}`);
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
    name: 'shows an accurate local-only privacy statement',
    run: async (harness, testName) => {
      const popup = harness.attachPage(await harness.browser.newPage(), 'essential-privacy-popup');
      try {
        await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
        await popup.click('#settingsHeader');
        const state = await popup.evaluate(async () => {
          const { pendingErrorReports } = await chrome.storage.local.get(['pendingErrorReports']);
          return {
            text: document.querySelector('#settingsContent')?.textContent || '',
            hasTelemetryToggle: Boolean(document.querySelector('#errorReportingToggle')),
            hasPendingReports: Array.isArray(pendingErrorReports) && pendingErrorReports.length > 0
          };
        });

        if (!state.text.includes('does not send telemetry')) throw new Error('Local-only privacy statement is missing');
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
        const historyVisible = await popup.$eval('#historyContainer', element => element.style.display === 'block');
        if (!historyVisible) throw new Error('Seeded history did not appear');

        await popup.click('#historyHeader');
        const historyState = await popup.evaluate(() => ({
          text: document.querySelector('#historyContent')?.textContent || '',
          hasMarkupInjection: Boolean(document.querySelector('#historyContent script'))
        }));
        if (!historyState.text.includes('refreshed')) throw new Error('History summary is missing');
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

async function runTests() {
  console.log('Starting fast end-to-end suite...');
  const harness = await createHarness({ profile: 'fast', trace: false });
  const timer = createPhaseTimer('fast', harness.basePhases, harness.startedAt);
  const outputDirectory = ensureOutputDirectory('fast');
  let failed = 0;
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
      { essentialTests: TEST_CASES.length, includesSmoke: true }
    ));
  }

  console.log(`Fast suite summary: ${TEST_CASES.length + 1 - failed} passed, ${failed} failed`);
  return failed === 0;
}

runTests()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
