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
  chrome.tabs.onUpdated.callbackQueue = [];
  chrome.tabs.onUpdated.addListener.mockImplementation(callback => {
    chrome.tabs.onUpdated.callbackQueue.push(callback);
  });
  chrome.tabs.onRemoved.callbackQueue = [];
  chrome.tabs.onRemoved.addListener.mockImplementation(callback => {
    chrome.tabs.onRemoved.callbackQueue.push(callback);
  });

  new Function('self', 'chrome', backgroundJs)(self, chrome);
  return {
    self,
    onMessage: chrome.runtime.onMessage.callbackQueue[0],
    onUpdated: chrome.tabs.onUpdated.callbackQueue[0],
    onRemoved: chrome.tabs.onRemoved.callbackQueue[0]
  };
}

function setRuntimeLastError(value) {
  Object.defineProperty(chrome.runtime, 'lastError', {
    configurable: true,
    value
  });
}

function expectEveryReloadToBypassLocalCache(tabId, expectedCalls = 1) {
  expect(chrome.tabs.reload).toHaveBeenCalledTimes(expectedCalls);
  chrome.tabs.reload.mock.calls.forEach(([actualTabId, options, callback]) => {
    expect(actualTabId).toBe(tabId);
    expect(options).toEqual({ bypassCache: true });
    expect(callback).toEqual(expect.any(Function));
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
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 1 },
      function: expect.any(Function)
    }), expect.any(Function));
    expectEveryReloadToBypassLocalCache(1);
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

  test('reports a tab with no readable URL as reloadable, not skipped (evidence that "tabs" is required)', async () => {
    // Without "tabs", Chrome hides restricted-page URLs, preventing the skip classification above.
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 13, title: 'Unreadable URL', url: undefined, discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabSkipped', tabId: 13
    }));
    expectEveryReloadToBypassLocalCache(13);
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

    expectEveryReloadToBypassLocalCache(7, 3);
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

    expectEveryReloadToBypassLocalCache(4);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete', success: true
    }));
  });

  test('reloads discarded tabs with cache bypass and without media capture', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 8, title: 'Discarded', url: 'https://example.com/discarded', discarded: true }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({
      id: tabId,
      status: 'unloaded',
      discarded: true
    }));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expectEveryReloadToBypassLocalCache(8);
  });

  test('keeps cache bypass enabled for every discarded-tab reload retry', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 12, title: 'Discarded retry', url: 'https://example.com/discarded-retry', discarded: true }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({
      id: tabId,
      status: 'unloaded',
      discarded: true
    }));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      setRuntimeLastError({ message: 'Discarded reload failed' });
      callback();
      setRuntimeLastError(undefined);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expectEveryReloadToBypassLocalCache(12, 3);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabFailed',
      tabId: 12,
      error: 'Discarded reload failed'
    }));
  });

  test('falls back to a cache-bypassing reload when media scripting fails', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 9, title: 'Script denied', url: 'https://example.com/denied', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      setRuntimeLastError({ message: 'Cannot access page' });
      callback();
      setRuntimeLastError(undefined);
    });
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      setRuntimeLastError(undefined);
      callback();
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expectEveryReloadToBypassLocalCache(9);
  });

  test('falls back to a cache-bypassing reload when media scripting throws synchronously', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 10, title: 'Script exception', url: 'https://example.com/exception', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation(() => {
      throw new Error('Synchronous scripting failure');
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expectEveryReloadToBypassLocalCache(10);
  });

  test('injects media restoration after a refreshed tab finishes loading', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 14, title: 'Media', url: 'https://example.com/media', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 1 } }
    ]));
    const { onMessage, onUpdated } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(100);
    expect(onUpdated).toEqual(expect.any(Function));
    onUpdated(14, { status: 'complete' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 14 },
      files: ['content-script.js']
    }, expect.any(Function));
  });

  test('does not inject media restoration while a refreshed tab is loading', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 15, title: 'Loading media', url: 'https://example.com/loading-media', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 1 } }
    ]));
    const { onMessage, onUpdated } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(100);
    expect(onUpdated).toEqual(expect.any(Function));
    onUpdated(15, { status: 'loading' });

    expect(chrome.scripting.executeScript).not.toHaveBeenCalledWith({
      target: { tabId: 15 },
      files: ['content-script.js']
    }, expect.any(Function));
  });

  test('does not inject media restoration for a tab that was never refreshed', () => {
    const { onUpdated } = executeBackgroundJs();

    expect(onUpdated).toEqual(expect.any(Function));
    onUpdated(16, { status: 'complete' });

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('does not schedule media restoration when capture finds no media', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 17, title: 'No media', url: 'https://example.com/no-media', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 0 } }
    ]));
    const { onMessage, onUpdated } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(100);
    expect(onUpdated).toEqual(expect.any(Function));
    onUpdated(17, { status: 'complete' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  test('schedules media restoration when the capture result shape is absent', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 18, title: 'Unknown capture', url: 'https://example.com/unknown-capture', discarded: false }
    ]));
    const { onMessage, onUpdated } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(100);
    expect(onUpdated).toEqual(expect.any(Function));
    onUpdated(18, { status: 'complete' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 18 },
      files: ['content-script.js']
    }, expect.any(Function));
  });

  test('cancels pending media restoration when the tab is removed', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 19, title: 'Removed', url: 'https://example.com/removed', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 1 } }
    ]));
    const { onMessage, onUpdated, onRemoved } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(100);
    expect(onUpdated).toEqual(expect.any(Function));
    expect(onRemoved).toEqual(expect.any(Function));
    onRemoved(19);
    onUpdated(19, { status: 'complete' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  test('injects media restoration exactly once per refreshed tab', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 20, title: 'Once', url: 'https://example.com/once', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 1 } }
    ]));
    const { onMessage, onUpdated } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(100);
    expect(onUpdated).toEqual(expect.any(Function));
    onUpdated(20, { status: 'complete' });
    onUpdated(20, { status: 'complete' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  test('does not inject media restoration when the reload itself failed', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 21, title: 'Reload failure', url: 'https://example.com/reload-failure', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 1 } }
    ]));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      setRuntimeLastError({ message: 'Tab was discarded' });
      callback();
      setRuntimeLastError(undefined);
    });
    const { onMessage, onUpdated } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(5000);
    onUpdated(21, { status: 'complete' });

    expect(chrome.scripting.executeScript).not.toHaveBeenCalledWith({
      target: { tabId: 21 },
      files: ['content-script.js']
    }, expect.any(Function));
  });

  test('reloads immediately after capture without an intervening delay', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 22, title: 'No wait', url: 'https://example.com/no-wait', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 1 } }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    // Let only the already-existing batch scheduling run, then assert the reload
    // has fired without advancing timers any further.
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(chrome.tabs.reload).toHaveBeenCalledWith(
      22,
      { bypassCache: true },
      expect.any(Function)
    );
  });

  test('times out a stalled cache-bypassing reload without issuing a cached fallback', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 11, title: 'Stalled', url: 'https://example.com/stalled', discarded: false }
    ]));
    chrome.tabs.reload.mockImplementation(() => {});
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expectEveryReloadToBypassLocalCache(11);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabFailed',
      tabId: 11,
      error: 'Timed out refreshing tab after 30 seconds'
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      success: false,
      details: expect.objectContaining({ failedCount: 1, processedTabs: 1 })
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
