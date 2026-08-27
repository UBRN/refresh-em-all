const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const popupPath = path.join(__dirname, '..', 'popup.js');
const popupJs = createInstrumenter().instrumentSync(
  fs.readFileSync(popupPath, 'utf8'),
  popupPath
);

function renderPopupDom() {
  document.body.innerHTML = `
    <h2></h2>
    <p class="refresh-explanation"></p>
    <button id="refreshAll">Refresh All Tabs</button>
    <button id="cancelRefresh" style="display:none">Cancel</button>
    <div id="loadingContainer" style="display:none">
      <div id="progressBar" aria-valuenow="0"><div id="progressFill"></div></div>
      <div id="statusText"></div>
      <div id="statsRunLine" style="display:none"></div>
      <div id="tabsContainer"></div>
    </div>
    <div id="errorContainer" style="display:none">
      <div id="errorSummary"></div><div id="errorDetails"></div>
    </div>
    <div id="historyContainer" style="display:none">
      <button id="historyHeader" aria-expanded="false"></button>
      <div id="historyContent" style="display:none"></div>
    </div>
    <div id="statsContainer" style="display:none">
      <button id="statsHeader" aria-expanded="false"></button>
      <div id="statsContent" style="display:none">
        <div id="statsToday"></div>
        <div id="statsLastRun"></div>
        <div id="statsWeek"></div>
        <div id="statsMonth"></div>
        <div id="statsTotal"></div>
        <p id="statsAccessHint" class="privacy-info" style="display:none"></p>
        <p id="statsNote" class="privacy-info"></p>
      </div>
    </div>
    <button id="settingsHeader" aria-expanded="false"></button>
    <div id="settingsContent" style="display:none">
      <button id="grantAccess" style="display:none"></button>
      <p id="grantAccessExplain" class="privacy-info" style="display:none"></p>
      <button id="resetStats"></button>
      <p class="privacy-info"></p>
    </div>
    <div id="confetti" style="display:none"></div>
  `;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function executePopupJs({
  operationState = { active: false },
  history = [],
  cacheStats,
  siteAccess = true,
  mediaAccessAsked = false,
  requestAccessResult = false
} = {}) {
  renderPopupDom();
  chrome.runtime.onMessage.callbackQueue = [];
  chrome.runtime.onMessage.addListener.mockImplementation(callback => {
    chrome.runtime.onMessage.callbackQueue.push(callback);
  });
  chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message.action === 'getOperationStatus') callback?.(operationState);
    else if (message.action === 'startRefresh') callback?.({ success: true });
    else if (message.action === 'cancelOperation') callback?.({ success: true });
    return Promise.resolve({});
  });
  chrome.storage.local.get.mockImplementation((keys, callback) => {
    if (keys.includes('cacheStats')) callback({ cacheStats });
    else if (keys.includes('mediaAccessAsked')) callback({ mediaAccessAsked });
    else callback({ refreshHistory: history });
  });
  chrome.permissions = {
    contains: jest.fn().mockResolvedValue(siteAccess),
    request: jest.fn().mockResolvedValue(requestAccessResult)
  };

  new Function('document', 'window', 'chrome', popupJs)(document, window, chrome);
  return chrome.runtime.onMessage.callbackQueue[0];
}

describe('Popup controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetTestEnvironment();
  });

  test('starts a refresh through the background worker and disables duplicate starts', async () => {
    executePopupJs();
    await flushPromises();

    document.getElementById('refreshAll').click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh' },
      expect.any(Function)
    );
    expect(document.getElementById('refreshAll').disabled).toBe(true);
    expect(document.getElementById('cancelRefresh').style.display).toBe('inline-block');
  });

  test('requests optional page-reading permission from the settings button', async () => {
    executePopupJs({ siteAccess: false, requestAccessResult: true });
    await flushPromises();

    document.getElementById('grantAccess').click();
    await flushPromises();

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  test('first refresh requests access once and still starts when refused', async () => {
    executePopupJs({ siteAccess: false, mediaAccessAsked: false, requestAccessResult: false });
    await flushPromises();

    document.getElementById('refreshAll').click();
    await flushPromises();

    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ mediaAccessAsked: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh' },
      expect.any(Function)
    );
  });

  test('later refresh does not request access automatically', async () => {
    executePopupJs({ siteAccess: false, mediaAccessAsked: true });
    await flushPromises();

    document.getElementById('refreshAll').click();

    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh' },
      expect.any(Function)
    );
  });

  test.each([
    [true, 'none'],
    [false, 'block']
  ])('renders optional-access controls for granted=%s', async (siteAccess, display) => {
    executePopupJs({ siteAccess });
    await flushPromises();

    expect(document.getElementById('grantAccess').style.display).toBe(display);
    expect(document.getElementById('statsAccessHint').style.display).toBe(display);
  });

  test('renders per-tab success, failure, skipped state, and processed progress', () => {
    const onMessage = executePopupJs();
    const tabs = [
      { id: 1, title: 'One' },
      { id: 2, title: 'Two' },
      { id: 3, title: 'Restricted' }
    ];

    onMessage({ action: 'refreshStarted', tabs });
    onMessage({ action: 'tabSucceeded', tabId: 1 });
    onMessage({ action: 'tabFailed', tabId: 2, error: 'Reload failed' });
    onMessage({ action: 'tabSkipped', tabId: 3 });
    onMessage({
      action: 'refreshProgress', current: 9, total: 12, percent: 75,
      successful: 5, failed: 2, skipped: 3
    });
    // Every count differs, so any swapped argument order in the statusProgress call fails here.
    expect(document.getElementById('statusText').textContent)
      .toBe('9 of 12 — 5 reloaded, 2 failed, 3 skipped');

    onMessage({
      action: 'refreshProgress', current: 3, total: 3, percent: 100,
      successful: 1, failed: 1, skipped: 1
    });
    onMessage({
      action: 'refreshComplete', success: false,
      details: { totalTabs: 3, processedTabs: 3, successfulTabs: 1, failedCount: 1, skippedCount: 1 },
      failedTabs: [{ id: 2, title: 'Two', error: 'Reload failed' }]
    });

    expect(document.querySelector('#tab-1 .tab-success').style.display).toBe('block');
    expect(document.querySelector('#tab-2 .tab-error').style.display).toBe('block');
    expect(document.querySelector('#tab-3 .tab-skipped').style.display).toBe('block');
    expect(document.getElementById('progressFill').style.width).toBe('100%');
    expect(document.getElementById('statusText').textContent).toContain('1 failed');
    expect(document.getElementById('errorDetails').textContent).toContain('Reload failed');
  });

  test('restores an active operation when the popup is reopened', () => {
    executePopupJs({
      operationState: {
        active: true,
        currentTabs: [{ id: 9, title: 'Restored' }],
        tabStatuses: { 9: 'success' },
        processedTabs: 1,
        totalTabs: 2,
        progress: 50,
        refreshedTabs: 1,
        failedTabs: 0,
        skippedTabs: 0
      }
    });

    expect(document.getElementById('progressFill').style.width).toBe('50%');
    expect(document.querySelector('#tab-9 .tab-success').style.display).toBe('block');
    expect(document.getElementById('refreshAll').disabled).toBe(true);
  });

  test('does not activate stress mode after five settings clicks', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => false);
    executePopupJs();

    const settings = document.getElementById('settingsHeader');
    for (let index = 0; index < 5; index++) settings.click();

    expect(document.getElementById('refreshAll').textContent).toBe(
      chrome.i18n.getMessage('actionRefreshAll')
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('respects reduced motion without changing the success message', () => {
    jest.useFakeTimers();
    window.matchMedia.mockImplementation(query => ({
      matches: true,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }));
    let onMessage = executePopupJs();

    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 2, processedTabs: 2, successfulTabs: 2, failedCount: 0, skippedCount: 0 }
    });

    expect(document.getElementById('confetti').childElementCount).toBe(0);
    expect(document.getElementById('confetti').style.display).not.toBe('block');
    expect(document.getElementById('statusText').textContent).toBe(
      chrome.i18n.getMessage('statusCompleteAll', ['2'])
    );

    window.matchMedia.mockImplementation(query => ({
      matches: false,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }));
    onMessage = executePopupJs();
    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 2, processedTabs: 2, successfulTabs: 2, failedCount: 0, skippedCount: 0 }
    });

    expect(document.querySelectorAll('#confetti .confetti-piece').length).toBeGreaterThan(0);
    jest.useRealTimers();
  });

  test('one click expands a section hidden by the stylesheet, not two', () => {
    // Production hides these sections through popup.html's stylesheet, not an inline
    // style. The DOM stub above hides them inline, which masks the real starting state,
    // so reproduce the stylesheet case explicitly.
    executePopupJs();
    const content = document.getElementById('historyContent');
    const header = document.getElementById('historyHeader');
    content.removeAttribute('style');
    const sheet = document.createElement('style');
    sheet.textContent = '#historyContent { display: none; }';
    document.head.appendChild(sheet);

    expect(window.getComputedStyle(content).display).toBe('none');

    header.click();

    expect(content.style.display).toBe('block');
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  test('renders sanitized local history without using stored tab markup', () => {
    executePopupJs({
      history: [{
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTabs: 4,
        successfulTabs: 2,
        failedCount: 1,
        skippedCount: 1,
        cancelled: false
      }]
    });

    expect(chrome.storage.local.get).toHaveBeenCalledWith(['refreshHistory'], expect.any(Function));
    expect(document.getElementById('historyContent').textContent)
      .toContain('2 of 4 reloaded; 1 failed, 1 skipped');
    expect(document.getElementById('historyContent').querySelector('script')).toBeNull();
  });

  test('shows the statistics section without page access so the hint is visible', async () => {
    executePopupJs({ siteAccess: false });
    await flushPromises();
    expect(document.getElementById('statsContainer').style.display).toBe('block');
    expect(document.getElementById('statsAccessHint').style.display).toBe('block');
  });

  test('hides absent statistics and renders five localized totals when seeded', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 7, 24, 12));
    executePopupJs();
    await flushPromises();
    expect(document.getElementById('statsContainer').style.display).toBe('none');

    executePopupJs({
      cacheStats: {
        lastRun: 1536,
        total: 10 * 1024 * 1024,
        days: {
          '2026-08-24': 2048,
          '2026-08-23': 3072,
          '2026-08-22': 4096,
          '2026-08-01': 1024
        }
      }
    });

    expect(document.getElementById('statsContainer').style.display).toBe('block');
    expect(document.getElementById('statsToday').textContent)
      .toBe('Today: at least 2.0 KB');
    expect(document.getElementById('statsLastRun').textContent)
      .toBe('Last reload: at least 1.5 KB');
    expect(document.getElementById('statsWeek').textContent)
      .toBe('Last 7 days: at least 9.0 KB');
    expect(document.getElementById('statsMonth').textContent)
      .toBe('Last 30 days: at least 10.0 KB');
    expect(document.getElementById('statsTotal').textContent)
      .toBe('All time: at least 10.0 MB');
    jest.useRealTimers();
  });

  test('resets locally measured saved-file figures with one click', () => {
    executePopupJs();

    document.getElementById('resetStats').click();

    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      ['cacheStats'],
      expect.any(Function)
    );
  });

  test('shows measured stale bytes on completion and hides zero on the next run', () => {
    const onMessage = executePopupJs();

    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1, staleBytes: 2048 }
    });
    expect(document.getElementById('statsRunLine').style.display).toBe('block');
    expect(document.getElementById('statsRunLine').textContent)
      .toBe('At least 2.0 KB came from copies Chrome saved earlier and will now be downloaded again.');

    onMessage({ action: 'refreshStarted', tabs: [{ id: 1, title: 'Next' }] });
    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1, staleBytes: 0 }
    });
    expect(document.getElementById('statsRunLine').style.display).toBe('none');
    expect(document.getElementById('statsRunLine').textContent).toBe('');
  });
});
