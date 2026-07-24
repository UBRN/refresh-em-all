const http = require('http');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const extensionPath = path.join(__dirname, '../..');
// CI only loads this trusted extension and the localhost test server.
const ciBrowserArgs = process.env.CI === 'true' ? ['--no-sandbox'] : [];

async function createTestServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html><head><title>Refresh audit</title></head><body>
      <script>
        sessionStorage.refreshAuditLoads = String(Number(sessionStorage.refreshAuditLoads || 0) + 1);
        document.title = location.pathname + ' load ' + sessionStorage.refreshAuditLoads;
      </script>
      <p>Local refresh test page</p>
    </body></html>`);
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

  // Chrome can keep a Manifest V3 worker dormant until an extension page opens.
  // Unpacked extension IDs are derived from the normalized absolute path.
  return [...crypto.createHash('sha256').update(extensionPath).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15])
    .map(nibble => String.fromCharCode(97 + nibble))
    .join('');
}

const TEST_CASES = [
  {
    name: 'reloads real pages and reports skipped pages separately',
    run: async (browser, extensionId, baseUrl) => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      const popup = await browser.newPage();
      const popupErrors = [];
      popup.on('pageerror', error => popupErrors.push(error.message));

      try {
        await Promise.all([
          pageA.goto(`${baseUrl}/a`),
          pageB.goto(`${baseUrl}/b`)
        ]);
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
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
      } finally {
        await Promise.all([pageA.close(), pageB.close(), popup.close()]);
      }
    }
  },
  {
    name: 'shows an accurate local-only privacy statement',
    run: async (browser, extensionId) => {
      const popup = await browser.newPage();
      try {
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
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
      } finally {
        await popup.close();
      }
    }
  },
  {
    name: 'renders sanitized refresh history',
    run: async (browser, extensionId) => {
      const popup = await browser.newPage();
      try {
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        const historyVisible = await popup.$eval('#historyContainer', element => element.style.display === 'block');
        if (!historyVisible) throw new Error('History did not appear after a completed refresh');

        await popup.click('#historyHeader');
        const historyState = await popup.evaluate(() => ({
          text: document.querySelector('#historyContent')?.textContent || '',
          hasMarkupInjection: Boolean(document.querySelector('#historyContent script'))
        }));
        if (!historyState.text.includes('refreshed')) throw new Error('History summary is missing');
        if (historyState.hasMarkupInjection) throw new Error('Unexpected executable markup in history');
      } finally {
        await popup.close();
      }
    }
  },
  {
    name: 'activates stress mode without replacing the refresh handler',
    run: async (browser, extensionId) => {
      const popup = await browser.newPage();
      const pageErrors = [];
      popup.on('pageerror', error => pageErrors.push(error.message));
      popup.on('dialog', dialog => dialog.accept());

      try {
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await popup.evaluate(() => {
          const settings = document.querySelector('#settingsHeader');
          for (let index = 0; index < 5; index++) settings.click();
        });
        await popup.waitForFunction(() =>
          document.querySelector('#refreshAll')?.textContent === 'Start Stress Test',
          { timeout: 5000 }
        );

        if (pageErrors.length > 0) throw new Error(`Stress activation errors: ${pageErrors.join('; ')}`);
      } finally {
        await popup.close();
      }
    }
  }
];

async function runTests() {
  console.log('Starting end-to-end tests…');
  const testServer = await createTestServer();
  let browser;
  let failed = 0;

  try {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--window-size=500,700',
        ...ciBrowserArgs
      ]
    });
    const extensionId = await findExtensionId(browser);

    for (const testCase of TEST_CASES) {
      process.stdout.write(`Running test: ${testCase.name}… `);
      try {
        await testCase.run(browser, extensionId, testServer.baseUrl);
        console.log('PASS');
      } catch (error) {
        failed++;
        console.log('FAIL');
        console.error(`  ${error.message}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    await testServer.close();
  }

  console.log(`Test summary: ${TEST_CASES.length - failed} passed, ${failed} failed`);
  return failed === 0;
}

runTests()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
