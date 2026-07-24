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
    <div id="settingsContent" style="display:none"></div>
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
    window.confirm.mockReturnValue(false);
    window.prompt.mockReturnValue(null);
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

  test('activates stress mode after five settings clicks without replacing the button', () => {
    jest.useFakeTimers();
    window.confirm.mockReturnValue(true);
    executePopupJs();

    const settings = document.getElementById('settingsHeader');
    for (let index = 0; index < 5; index++) settings.click();

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(document.getElementById('refreshAll').textContent).toBe('Start Stress Test');
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
