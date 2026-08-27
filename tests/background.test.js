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
    chrome.permissions = {
      contains: jest.fn().mockResolvedValue(true)
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

  test('keeps the toolbar icon colorful through a completed refresh', async () => {
    // The manifest declares the colorful icons as action.default_icon. An earlier
    // version "reset" to the monochrome assets/icon-refresh-em-*.png set when a
    // refresh finished, so the first completed refresh greyed the toolbar icon and
    // Chrome kept that override.
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 31, title: 'One', url: 'https://example.com/one', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      callback([{ result: { success: true, count: 0, staleBytes: 0 } }]);
    });
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => callback());
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(5000);

    expect(chrome.action.setIcon).toHaveBeenCalled();
    for (const [details] of chrome.action.setIcon.mock.calls) {
      for (const iconPath of Object.values(details.path)) {
        expect(iconPath).toContain('icon-refresh-em-colorful-');
      }
    }
  });

  test('measures only stale cached resource encoded byte sizes', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 23, title: 'Cached', url: 'https://example.com/cached', discarded: false }
    ]));
    let injectedFunction;
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      injectedFunction = details.function;
      callback([{ result: { success: true, count: 0 } }]);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);

    const originalDescriptor = Object.getOwnPropertyDescriptor(performance, 'getEntriesByType');
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: jest.fn(() => [
        { transferSize: 0, decodedBodySize: 4000, encodedBodySize: 1200 },
        { transferSize: 500, decodedBodySize: 2000, encodedBodySize: 400 },
        { transferSize: 0, decodedBodySize: 0, encodedBodySize: 0 }
      ])
    });

    let result;
    try {
      result = injectedFunction();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(performance, 'getEntriesByType', originalDescriptor);
      } else {
        delete performance.getEntriesByType;
      }
    }

    expect(result).toEqual({ success: true, count: 0, staleBytes: 1200 });
  });

  test('stores merged cache statistics and prunes daily totals to 31 dates', async () => {
    jest.setSystemTime(new Date(2026, 7, 24, 12));
    const days = {};
    for (let offset = 0; offset < 35; offset++) {
      const date = new Date(2026, 6, 20 + offset, 12);
      days[date.toISOString().slice(0, 10)] = 10;
    }
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 24, title: 'Measured', url: 'https://example.com/measured', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.([
      { result: { success: true, count: 0, staleBytes: 256 } }
    ]));
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      callback(keys.includes('cacheStats')
        ? { cacheStats: { lastRun: 999, total: 1024, days } }
        : { refreshHistory: [] });
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    const statsWriteIndex = chrome.storage.local.set.mock.calls.findIndex(([value]) => value.cacheStats);
    const historyWriteIndex = chrome.storage.local.set.mock.calls.findIndex(([value]) => value.refreshHistory);
    expect(statsWriteIndex).toBeGreaterThanOrEqual(0);
    const cacheStats = chrome.storage.local.set.mock.calls[statsWriteIndex][0].cacheStats;
    expect(cacheStats.lastRun).toBe(256);
    expect(cacheStats.total).toBe(1280);
    expect(cacheStats.days['2026-08-24']).toBe(256);
    expect(Object.keys(cacheStats.days)).toHaveLength(31);
    expect(cacheStats.days).not.toHaveProperty('2026-07-24');
    expect(cacheStats.days).toHaveProperty('2026-07-25');
    expect(statsWriteIndex).toBeLessThan(historyWriteIndex);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      details: expect.objectContaining({ staleBytes: 256 })
    }));
  });

  test('refreshes ordinary tabs and reports restricted pages as skipped', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 1, title: 'Normal', url: 'https://example.com', discarded: false },
      { id: 2, title: 'Settings', url: 'chrome://settings', discarded: false }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({
      id: tabId,
      status: 'complete',
      discarded: false,
      url: tabId === 1 ? 'https://example.com' : 'chrome://settings'
    }));
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

  test('refreshes a tab that navigated away from a restricted URL while queued', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 27, title: 'Moved', url: 'chrome://settings', discarded: false }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({
      id: tabId,
      status: 'complete',
      discarded: false,
      url: 'https://example.com/current'
    }));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expectEveryReloadToBypassLocalCache(27);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabSkipped', tabId: 27
    }));
  });

  test('skips a tab that navigated to a restricted URL while queued', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 28, title: 'Moved', url: 'https://example.com/old', discarded: false }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => callback({
      id: tabId,
      status: 'complete',
      discarded: false,
      url: 'chrome://extensions'
    }));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabSkipped', tabId: 28
    }));
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('reloads every ordinary tab without scripting when site access is missing', async () => {
    chrome.permissions.contains.mockResolvedValue(false);
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 25, title: 'One', url: 'https://example.com/one', discarded: false },
      { id: 26, title: 'Two', url: 'https://example.com/two', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(2);
    for (const [, options] of chrome.tabs.reload.mock.calls) {
      expect(options).toEqual({ bypassCache: true });
    }
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

  test('does not let a stale reload callback mutate the replacement refresh', async () => {
    const reloadCallbacks = new Map();
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback(queryCount++ === 0
      ? [{ id: 40, title: 'Old', url: 'https://example.com/old', discarded: false }]
      : [{ id: 41, title: 'New', url: 'https://example.com/new', discarded: false }]
    ));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      reloadCallbacks.set(tabId, callback);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(reloadCallbacks.has(40)).toBe(true);

    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    const secondStartResponse = jest.fn();
    onMessage({ action: 'startRefresh' }, {}, secondStartResponse);
    await jest.advanceTimersByTimeAsync(0);
    expect(reloadCallbacks.has(41)).toBe(true);

    setRuntimeLastError({ message: 'Old reload failed' });
    reloadCallbacks.get(40)();
    setRuntimeLastError(undefined);
    reloadCallbacks.get(41)();
    await jest.runAllTimersAsync();

    expect(secondStartResponse).toHaveBeenCalledWith({ success: true });
    const progressMessages = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'refreshProgress');
    expect(progressMessages).toEqual([
      expect.objectContaining({ current: 1, total: 1, successful: 1, failed: 0 })
    ]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabFailed', tabId: 40
    }));
    const historyWrites = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .filter(Boolean);
    expect(historyWrites).toHaveLength(2);
    expect(historyWrites[1][0]).toEqual(expect.objectContaining({
      totalTabs: 1,
      successfulTabs: 1,
      failedCount: 0,
      cancelled: false
    }));
  });

  test('ignores a tabs query callback from a cancelled generation', async () => {
    let firstQueryCallback;
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => {
      if (queryCount++ === 0) {
        firstQueryCallback = callback;
        return;
      }
      callback([
        { id: 101, title: 'Replacement', url: 'https://example.com/replacement', discarded: false }
      ]);
    });
    const { onMessage } = executeBackgroundJs();
    const firstStartResponse = jest.fn();

    onMessage({ action: 'startRefresh' }, {}, firstStartResponse);
    expect(firstQueryCallback).toEqual(expect.any(Function));
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);

    firstQueryCallback([
      { id: 100, title: 'Obsolete', url: 'https://example.com/obsolete', discarded: false }
    ]);
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([101]);
    expect(firstStartResponse).toHaveBeenCalledWith({ success: false });
    const replacementCompletion = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'refreshComplete' && !message.details.cancelled)
      .at(-1);
    expect(replacementCompletion.details).toEqual(expect.objectContaining({
      totalTabs: 1,
      processedTabs: 1,
      successfulTabs: 1
    }));
  });

  test('ignores a permission result from a cancelled generation', async () => {
    let resolveFirstPermission;
    let permissionCallCount = 0;
    chrome.permissions.contains.mockImplementation(() => {
      if (permissionCallCount++ === 0) {
        return new Promise(resolve => { resolveFirstPermission = resolve; });
      }
      return Promise.resolve(true);
    });
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback(queryCount++ === 0
      ? [{ id: 102, title: 'Obsolete', url: 'https://example.com/obsolete', discarded: false }]
      : [{ id: 103, title: 'Replacement', url: 'https://example.com/replacement', discarded: false }]
    ));
    const { onMessage } = executeBackgroundJs();
    const firstStartResponse = jest.fn();

    onMessage({ action: 'startRefresh' }, {}, firstStartResponse);
    await Promise.resolve();
    expect(resolveFirstPermission).toEqual(expect.any(Function));
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);

    resolveFirstPermission(true);
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([103]);
    expect(firstStartResponse).toHaveBeenCalledWith({ success: false });
    const replacementCompletion = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'refreshComplete' && !message.details.cancelled)
      .at(-1);
    expect(replacementCompletion.details).toEqual(expect.objectContaining({
      totalTabs: 1,
      processedTabs: 1,
      successfulTabs: 1
    }));
  });

  test('cancels a restored operation while permission lookup is pending', async () => {
    let resolvePermission;
    chrome.permissions.contains.mockImplementation(() => new Promise(resolve => {
      resolvePermission = resolve;
    }));
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: [
          { id: 104, title: 'Restored', url: 'https://example.com/restored', discarded: false }
        ],
        processedTabs: 0,
        refreshedTabs: 0,
        failedTabDetails: [],
        skippedTabIds: [],
        tabStatuses: { 104: 'pending' },
        cancelled: false,
        resumeCount: 0,
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));
    const { onMessage } = executeBackgroundJs();
    await Promise.resolve();
    const cancelResponse = jest.fn();

    onMessage({ action: 'cancelOperation' }, {}, cancelResponse);
    resolvePermission(true);
    await jest.runAllTimersAsync();

    expect(cancelResponse).toHaveBeenCalledWith({ success: true });
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('does not dispatch capture after a cancelled tabs get callback returns', async () => {
    let getCallback;
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 105, title: 'Pending get', url: 'https://example.com/pending-get', discarded: false }
    ]));
    chrome.tabs.get.mockImplementation((tabId, callback) => {
      getCallback = callback;
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(getCallback).toEqual(expect.any(Function));
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    getCallback({
      id: 105,
      status: 'complete',
      discarded: false,
      url: 'https://example.com/pending-get'
    });
    await jest.runAllTimersAsync();

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('does not reload after a cancelled capture callback returns', async () => {
    let captureCallback;
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 106, title: 'Pending capture', url: 'https://example.com/pending-capture', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      captureCallback = callback;
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(captureCallback).toEqual(expect.any(Function));
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    captureCallback([{ result: { success: true, count: 0, staleBytes: 100 } }]);
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('does not run a fallback reload after capture cancellation', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 107, title: 'Capture throws', url: 'https://example.com/capture-throws', discarded: false }
    ]));
    let onMessage;
    chrome.scripting.executeScript.mockImplementation(() => {
      onMessage({ action: 'cancelOperation' }, {}, jest.fn());
      throw new Error('Capture failed after cancellation');
    });
    ({ onMessage } = executeBackgroundJs());

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  test('serializes back-to-back finalizations without losing statistics or history order', async () => {
    const store = {
      cacheStats: { lastRun: 0, total: 0, days: {} },
      refreshHistory: []
    };
    const cacheReads = [];
    const historyReads = [];
    let deferReads = false;
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (!deferReads) {
        callback(keys.includes('cacheStats')
          ? { cacheStats: store.cacheStats }
          : { refreshHistory: store.refreshHistory });
        return;
      }

      if (keys.includes('cacheStats')) {
        const snapshot = JSON.parse(JSON.stringify(store.cacheStats));
        cacheReads.push(() => callback({ cacheStats: snapshot }));
      } else {
        const snapshot = JSON.parse(JSON.stringify(store.refreshHistory));
        historyReads.push(() => callback({ refreshHistory: snapshot }));
      }
    });
    chrome.storage.local.set.mockImplementation((data, callback) => {
      if (data.cacheStats) store.cacheStats = data.cacheStats;
      if (data.refreshHistory) store.refreshHistory = data.refreshHistory;
      callback?.();
    });
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback(queryCount++ === 0
      ? [{ id: 108, title: 'First', url: 'https://example.com/first', discarded: false }]
      : [
          { id: 109, title: 'Second A', url: 'https://example.com/second-a', discarded: false },
          { id: 110, title: 'Second B', url: 'https://example.com/second-b', discarded: false }
        ]
    ));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback([
      { result: { success: true, count: 0, staleBytes: 10 } }
    ]));
    const { onMessage } = executeBackgroundJs();
    deferReads = true;

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    cacheReads.pop()();
    historyReads.pop()();
    await Promise.resolve();
    await Promise.resolve();
    cacheReads.pop()();
    historyReads.pop()();
    await Promise.resolve();

    expect(store.cacheStats.total).toBe(30);
    expect(store.refreshHistory.map(entry => entry.totalTabs)).toEqual([2, 1]);
  });

  test('includes the operation generation in worker state and broadcasts', async () => {
    let reloadCallback;
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 111, title: 'Generation', url: 'https://example.com/generation', discarded: false }
    ]));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      reloadCallback = callback;
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    const statusResponse = jest.fn();
    onMessage({ action: 'getOperationStatus' }, {}, statusResponse);

    expect(statusResponse).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshStarted',
      generation: 1
    }));

    reloadCallback();
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshProgress',
      generation: 1
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      generation: 1
    }));
  });

  test('cancels immediately and accepts a replacement refresh on the next tick', async () => {
    const firstTabs = Array.from({ length: 6 }, (_, index) => ({
      id: 50 + index,
      title: `First ${index}`,
      url: `https://example.com/${index}`,
      discarded: false
    }));
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback(queryCount++ === 0
      ? firstTabs
      : [{ id: 59, title: 'Replacement', url: 'https://example.com/replacement', discarded: false }]
    ));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(400);
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(5);

    const cancelResponse = jest.fn();
    onMessage({ action: 'cancelOperation' }, {}, cancelResponse);
    await Promise.resolve();
    const secondStartResponse = jest.fn();
    onMessage({ action: 'startRefresh' }, {}, secondStartResponse);
    await jest.runAllTimersAsync();

    expect(cancelResponse).toHaveBeenCalledWith({ success: true });
    expect(secondStartResponse).toHaveBeenCalledWith({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      details: expect.objectContaining({ cancelled: true })
    }));
    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([50, 51, 52, 53, 54, 59]);
  });

  test('does not let an obsolete retry timer record a failure', async () => {
    chrome.permissions.contains.mockResolvedValue(false);
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 60, title: 'Retry', url: 'https://example.com/retry', discarded: false }
    ]));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      setRuntimeLastError({ message: 'Retry failed' });
      callback();
      setRuntimeLastError(undefined);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'tabFailed', tabId: 60
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      details: expect.objectContaining({ failedCount: 0, cancelled: true }),
      failedTabs: []
    }));
  });

  test('resumes an active session snapshot from its processed tab cursor', async () => {
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: [
          { id: 70, title: 'Done', url: 'https://example.com/done', discarded: false },
          { id: 71, title: 'Next', url: 'https://example.com/next', discarded: false },
          { id: 72, title: 'Last', url: 'https://example.com/last', discarded: false }
        ],
        processedTabs: 1,
        refreshedTabs: 1,
        failedTabDetails: [],
        skippedTabIds: [],
        tabStatuses: { 70: 'success', 71: 'pending', 72: 'pending' },
        cancelled: false,
        resumeCount: 0,
        staleBytes: 10,
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([71, 72]);
    const historyWrite = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .filter(Boolean)
      .at(-1);
    expect(historyWrite[0]).toEqual(expect.objectContaining({
      totalTabs: 3,
      successfulTabs: 3,
      failedCount: 0,
      cancelled: false
    }));
  });

  test('reconciles a session snapshot that reached the resume cap', async () => {
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: [
          { id: 80, title: 'Done', url: 'https://example.com/done', discarded: false },
          { id: 81, title: 'Pending', url: 'https://example.com/pending', discarded: false }
        ],
        processedTabs: 1,
        refreshedTabs: 1,
        failedTabDetails: [],
        skippedTabIds: [],
        tabStatuses: { 80: 'success', 81: 'pending' },
        cancelled: false,
        resumeCount: 3,
        staleBytes: 20,
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    const historyWrite = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .filter(Boolean)
      .at(-1);
    expect(historyWrite[0]).toEqual(expect.objectContaining({ totalTabs: 2, successfulTabs: 1 }));
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      refreshOperationState: expect.objectContaining({ active: false, interrupted: true })
    }, expect.any(Function));
    expect(chrome.storage.session.remove.mock.invocationCallOrder[0])
      .toBeLessThan(chrome.storage.session.set.mock.invocationCallOrder.at(-1));
  });

  test('ignores inactive session state and safely reconciles malformed active state', async () => {
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: { active: false, currentTabs: [] }
    }));

    expect(() => executeBackgroundJs()).not.toThrow();
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).not.toHaveBeenCalled();

    chrome.storage.session.set.mockClear();
    chrome.storage.session.remove.mockClear();
    chrome.storage.local.set.mockClear();
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: 'not an array',
        processedTabs: 'not a number',
        refreshedTabs: Infinity,
        failedTabDetails: {},
        skippedTabIds: 'not an array',
        tabStatuses: [],
        staleBytes: 'not a number',
        startTime: 'not a date',
        resumeCount: 0
      }
    }));

    expect(() => executeBackgroundJs()).not.toThrow();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      refreshOperationState: expect.objectContaining({ active: false, interrupted: true })
    }, expect.any(Function));
  });

  test('filters malformed tab records before resuming an interrupted operation', async () => {
    chrome.permissions.contains.mockResolvedValue(false);
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: [
          null,
          { id: 'bad', title: 'Bad id' },
          { id: 112, title: 'Valid', url: 'https://example.com/valid', discarded: false }
        ],
        processedTabs: 0,
        refreshedTabs: 0,
        failedTabDetails: [null],
        skippedTabIds: [null, 'bad', 999],
        tabStatuses: { 112: 'pending' },
        cancelled: false,
        resumeCount: 0,
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      setRuntimeLastError({ message: 'Restored reload failed' });
      callback();
      setRuntimeLastError(undefined);
    });

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([112, 112, 112]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      details: expect.objectContaining({ totalTabs: 1, failedCount: 1 }),
      failedTabs: [expect.objectContaining({ id: 112 })]
    }));
  });

  test('normalizes a stored operation before returning it to the popup', () => {
    const storedState = {
      active: false,
      interrupted: true,
      progress: 20,
      currentTabs: 'bad',
      tabStatuses: [],
      failedTabDetails: {}
    };
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: storedState
    }));
    const { onMessage } = executeBackgroundJs();
    const sendResponse = jest.fn();

    onMessage({ action: 'getOperationStatus' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({
      ...storedState,
      currentTabs: [],
      tabStatuses: {},
      failedTabDetails: []
    });
  });

  test('resets the resume count when a new manual refresh starts', async () => {
    chrome.permissions.contains.mockResolvedValue(false);
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: [
          { id: 113, title: 'Resumed', url: 'https://example.com/resumed', discarded: false }
        ],
        processedTabs: 0,
        refreshedTabs: 0,
        failedTabDetails: [],
        skippedTabIds: [],
        tabStatuses: { 113: 'pending' },
        cancelled: false,
        resumeCount: 2,
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 114, title: 'Manual', url: 'https://example.com/manual', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();

    await jest.runAllTimersAsync();
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    const manualSnapshots = chrome.storage.session.set.mock.calls
      .map(([value]) => value.refreshOperationState)
      .filter(state => state?.active && state.currentTabs?.some(tab => tab.id === 114));
    expect(manualSnapshots.at(-1)).toEqual(expect.objectContaining({ resumeCount: 0 }));
  });

  test('drops tab records when reconciling an interrupted operation', async () => {
    chrome.storage.session.get.mockImplementation((keys, callback) => callback({
      refreshOperationState: {
        active: true,
        currentTabs: [
          { id: 115, title: 'Private title', url: 'https://private.example', favIconUrl: 'https://private.example/icon' },
          { id: 116, title: 'Pending', url: 'https://example.com/pending' }
        ],
        processedTabs: 1,
        refreshedTabs: 0,
        failedTabDetails: [{ id: 115, title: 'Private title', error: 'Failed' }],
        skippedTabIds: [116],
        tabStatuses: { 115: 'error', 116: 'skipped' },
        cancelled: false,
        resumeCount: 3,
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    const interruptedRecord = chrome.storage.session.set.mock.calls
      .map(([value]) => value.refreshOperationState)
      .find(state => state?.interrupted === true);
    expect(interruptedRecord).toEqual({
      active: false,
      interrupted: true,
      progress: 50,
      totalTabs: 2,
      processedTabs: 1,
      refreshedTabs: 0,
      failedTabs: 1,
      skippedTabs: 1,
      cancelled: false,
      lastUpdated: expect.any(String)
    });
  });

  test('does not attribute a late script result to the replacement refresh', async () => {
    let firstCaptureCallback;
    let secondReloadCallback;
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback(queryCount++ === 0
      ? [{ id: 90, title: 'Old capture', url: 'https://example.com/old-capture', discarded: false }]
      : [{ id: 91, title: 'New capture', url: 'https://example.com/new-capture', discarded: false }]
    ));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      if (details.target.tabId === 90) {
        firstCaptureCallback = callback;
        return;
      }
      callback([{ result: { success: true, count: 0, staleBytes: 5 } }]);
    });
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      if (tabId === 91) {
        secondReloadCallback = callback;
        return;
      }
      callback();
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(firstCaptureCallback).toEqual(expect.any(Function));
    expect(secondReloadCallback).toEqual(expect.any(Function));

    firstCaptureCallback([{ result: { success: true, count: 0, staleBytes: 1000 } }]);
    secondReloadCallback();
    await jest.runAllTimersAsync();

    const cacheWrites = chrome.storage.local.set.mock.calls
      .map(([value]) => value.cacheStats)
      .filter(Boolean);
    expect(cacheWrites.at(-1)).toEqual(expect.objectContaining({ lastRun: 5, total: 5 }));
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
