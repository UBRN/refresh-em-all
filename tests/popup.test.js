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
      <div id="tabsContainer"></div>
    </div>
    <div id="errorContainer" style="display:none">
      <div id="errorSummary"></div><div id="errorDetails"></div>
    </div>
    <div id="historyContainer" style="display:none">
      <button id="historyHeader" aria-expanded="false"></button>
      <div id="historyContent" style="display:none"></div>
    </div>
    <button id="settingsHeader" aria-expanded="false"></button>
    <div id="settingsContent" style="display:none"><p class="privacy-info"></p></div>
    <div id="confetti" style="display:none"></div>
  `;
}

function executePopupJs({ operationState = { active: false }, history = [] } = {}) {
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
    callback({ refreshHistory: history });
  });

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

  test('starts a refresh through the background worker and disables duplicate starts', () => {
    executePopupJs();

    document.getElementById('refreshAll').click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh' },
      expect.any(Function)
    );
    expect(document.getElementById('refreshAll').disabled).toBe(true);
    expect(document.getElementById('cancelRefresh').style.display).toBe('inline-block');
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
      .toBe('Processed 9/12 — 5 refreshed, 2 failed, 3 skipped');

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
    expect(document.getElementById('historyContent').textContent).toContain('2/4 refreshed, 1 failed, 1 skipped');
    expect(document.getElementById('historyContent').querySelector('script')).toBeNull();
  });
});
