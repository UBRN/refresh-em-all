const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const backgroundPath = path.join(__dirname, '..', 'background.js');
const backgroundJs = createInstrumenter().instrumentSync(
  fs.readFileSync(backgroundPath, 'utf8'),
  backgroundPath
);

function executeBackgroundJs() {
  const self = { addEventListener: jest.fn() };
  chrome.runtime.onMessage.callbackQueue = [];
  chrome.runtime.onMessage.addListener.mockImplementation(callback => {
    chrome.runtime.onMessage.callbackQueue.push(callback);
  });

  new Function('self', 'chrome', backgroundJs)(self, chrome);
  return { self, onMessage: chrome.runtime.onMessage.callbackQueue[0] };
}

function setRuntimeLastError(value) {
  Object.defineProperty(chrome.runtime, 'lastError', {
    configurable: true,
    value
  });
}

describe('Background refresh worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setRuntimeLastError(undefined);

    chrome.runtime.sendMessage.mockImplementation(() => Promise.resolve({}));
    chrome.storage.sync.get.mockImplementation((keys, callback) => callback({}));
    chrome.storage.sync.remove.mockImplementation(() => {});
    chrome.storage.local.get.mockImplementation((keys, callback) => callback({ refreshHistory: [] }));
    chrome.storage.local.set.mockImplementation((data, callback) => callback?.());
    chrome.storage.local.remove.mockImplementation(() => {});
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({}));
    chrome.storage.session.set.mockImplementation((data, callback) => callback?.());
    chrome.scripting = {
      executeScript: jest.fn((details, callback) => callback?.([]))
    };
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({ id: tabId, status: 'complete', discarded: false }));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => callback());
  });

  afterEach(() => {
    jest.useRealTimers();
    setRuntimeLastError(undefined);
  });

  test('registers top-level error and message listeners', () => {
    const { self, onMessage } = executeBackgroundJs();

    expect(self.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(self.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    expect(onMessage).toEqual(expect.any(Function));
  });

  test('refreshes ordinary tabs and reports restricted pages as skipped', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 1, title: 'Normal', url: 'https://example.com', discarded: false },
      { id: 2, title: 'Settings', url: 'chrome://settings', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();
    const sendResponse = jest.fn();

    onMessage({ action: 'startRefresh' }, {}, sendResponse);
    await jest.runAllTimersAsync();

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabSucceeded', tabId: 1
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabSkipped', tabId: 2
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshProgress', current: 2, total: 2, successful: 1, skipped: 1
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      success: true,
      details: expect.objectContaining({ successfulTabs: 1, skippedCount: 1, processedTabs: 2 })
    }));
  });

  test('emits a failure result after retries and still reaches 100 percent processed', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 7, title: 'Broken', url: 'https://example.com/broken', discarded: false }
    ]));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      setRuntimeLastError({ message: 'Reload failed' });
      callback();
      setRuntimeLastError(undefined);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).toHaveBeenCalledTimes(3);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabFailed', tabId: 7, error: 'Reload failed'
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshProgress', current: 1, total: 1, percent: 100, failed: 1
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete', success: false,
      details: expect.objectContaining({ failedCount: 1, processedTabs: 1 })
    }));
  });

  test('bounds the wait for tabs that remain loading', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 4, title: 'Loading', url: 'https://example.com/loading', discarded: false }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({ id: tabId, status: 'loading', discarded: false }));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete', success: true
    }));
  });

  test('supports cancellation from the popup', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 5, title: 'Normal', url: 'https://example.com', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();
    const cancelResponse = jest.fn();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    onMessage({ action: 'cancelOperation' }, {}, cancelResponse);
    await jest.runAllTimersAsync();

    expect(cancelResponse).toHaveBeenCalledWith({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete', success: false,
      details: expect.objectContaining({ cancelled: true })
    }));
  });

  test('migrates old sync history without retaining tab titles or URLs', () => {
    chrome.storage.sync.get.mockImplementation((keys, callback) => callback({
      refreshHistory: [{
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTabs: 2,
        successfulTabs: 1,
        failedTabs: [{ title: 'Sensitive title', url: 'https://private.example' }]
      }],
      errorReportingConsent: true
    }));
    chrome.storage.local.get.mockImplementation((keys, callback) => callback({}));

    executeBackgroundJs();

    const migratedHistoryCall = chrome.storage.local.set.mock.calls.find(call => call[0].refreshHistory);
    expect(migratedHistoryCall[0].refreshHistory[0]).toEqual(expect.objectContaining({
      failedCount: 1,
      totalTabs: 2,
      successfulTabs: 1
    }));
    expect(JSON.stringify(migratedHistoryCall[0])).not.toContain('Sensitive title');
    expect(JSON.stringify(migratedHistoryCall[0])).not.toContain('private.example');
    expect(chrome.storage.sync.remove).toHaveBeenCalledWith(['refreshHistory', 'errorReportingConsent']);
  });
});
