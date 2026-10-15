const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const backgroundPath = path.join(__dirname, '..', 'background.js');
const backgroundJs = createInstrumenter().instrumentSync(
  fs.readFileSync(backgroundPath, 'utf8'),
  backgroundPath
);

function executeBackgroundJs() {
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

  new Function('chrome', backgroundJs)(chrome);
  return {
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
  let sessionStore;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setRuntimeLastError(undefined);

    chrome.runtime.sendMessage.mockImplementation(() => Promise.resolve({}));
    chrome.storage.local.get.mockImplementation((keys, callback) => callback({ refreshHistory: [] }));
    chrome.storage.local.set.mockImplementation((data, callback) => callback?.());
    chrome.storage.local.remove.mockImplementation(() => {});
    sessionStore = {};
    chrome.storage.session.get.mockImplementation((keys, callback) => {
      callback(Object.fromEntries(keys
        .filter(key => Object.hasOwn(sessionStore, key))
        .map(key => [key, sessionStore[key]])));
    });
    chrome.storage.session.set.mockImplementation((data, callback) => {
      Object.assign(sessionStore, data);
      callback?.();
    });
    chrome.storage.session.remove.mockImplementation((keys, callback) => {
      keys.forEach(key => delete sessionStore[key]);
      callback?.();
    });
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

  test('registers the message listener', () => {
    const { onMessage } = executeBackgroundJs();

    expect(onMessage).toEqual(expect.any(Function));
  });

  test('restores scheduled media after the worker is reloaded', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 122, title: 'Media', url: 'https://example.com/media', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => callback?.(
      details.func ? [{ result: { success: true, count: 1, staleBytes: 0 } }] : []
    ));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    const { onUpdated } = executeBackgroundJs();
    chrome.scripting.executeScript.mockClear();
    await onUpdated(122, { status: 'complete' });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 122 },
      files: ['content-script.js']
    }, expect.any(Function));
  });

  test('does not restore media after the pending entry expires', async () => {
    jest.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
    sessionStore.pendingMediaRestores = { 123: Date.now() - 1 };
    const { onUpdated } = executeBackgroundJs();

    await onUpdated(123, { status: 'complete' });

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('captures the resolved source of media that uses <source> children', async () => {
    // The injected capture stored element.src, which is empty whenever the
    // resource comes from a <source> child. That wrote a placeholder instead of
    // an identity, so the restore side had nothing to compare against.
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 41, title: 'Podcast', url: 'https://example.com/podcast', discarded: false }
    ]));
    let injectedFunction;
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      injectedFunction = details.func;
      callback([{ result: { success: true, count: 0 } }]);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);

    document.body.innerHTML = [
      '<video><source src="https://example.com/clip.mp4"></video>',
      '<audio><source src="https://example.com/track.mp3"></audio>'
    ].join('');
    const video = document.querySelector('video');
    const audio = document.querySelector('audio');
    Object.defineProperty(video, 'currentSrc', {
      value: 'https://example.com/clip.mp4', configurable: true
    });
    Object.defineProperty(audio, 'currentSrc', {
      value: 'https://example.com/track.mp3', configurable: true
    });

    sessionStorage.setItem.mockClear();

    let saved;
    try {
      const result = injectedFunction();
      expect(result.count).toBe(2);
      saved = JSON.parse(sessionStorage.setItem.mock.calls[0][1]);
    } finally {
      // Later tests in this file assert on an empty page, so the injected
      // capture must not find leftover media elements.
      document.body.innerHTML = '';
    }

    expect(saved.video_0.src).toBe('https://example.com/clip.mp4');
    expect(saved.audio_0.src).toBe('https://example.com/track.mp3');
  });

  test('measures only stale cached resource encoded byte sizes', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 23, title: 'Cached', url: 'https://example.com/cached', discarded: false }
    ]));
    let injectedFunction;
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      injectedFunction = details.func;
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
      func: expect.any(Function)
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
    await onUpdated(14, { status: 'complete' });

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
    await onUpdated(15, { status: 'loading' });

    expect(chrome.scripting.executeScript).not.toHaveBeenCalledWith({
      target: { tabId: 15 },
      files: ['content-script.js']
    }, expect.any(Function));
  });

  test('does not inject media restoration for a tab that was never refreshed', async () => {
    const { onUpdated } = executeBackgroundJs();

    expect(onUpdated).toEqual(expect.any(Function));
    await onUpdated(16, { status: 'complete' });

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
    await onUpdated(17, { status: 'complete' });

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
    await onUpdated(18, { status: 'complete' });

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
    await onRemoved(19);
    await onUpdated(19, { status: 'complete' });

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
    await onUpdated(20, { status: 'complete' });
    await onUpdated(20, { status: 'complete' });

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
    await onUpdated(21, { status: 'complete' });

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
      error: 'Timed out reloading tab after 30 seconds'
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
    const workerStart = new Date('2026-10-15T09:00:00.000Z').getTime();
    jest.setSystemTime(workerStart);
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

    expect(statusResponse).toHaveBeenCalledWith(expect.objectContaining({ generation: workerStart + 1 }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshStarted',
      generation: workerStart + 1
    }));

    reloadCallback();
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshProgress',
      generation: workerStart + 1
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      generation: workerStart + 1
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

  test('records an interrupted run in history instead of resuming it', async () => {
    sessionStore.refreshOperationState = {
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
      staleBytes: 10,
      startTime: '2026-08-27T09:00:00.000Z'
    };

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    const historyWrite = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .filter(Boolean)
      .at(-1);
    expect(historyWrite[0]).toEqual(expect.objectContaining({
      totalTabs: 3,
      successfulTabs: 1,
      failedCount: 0,
      cancelled: false,
      interrupted: true
    }));
    expect(sessionStore.refreshOperationState).toEqual(expect.objectContaining({
      active: false,
      interrupted: true,
      processedTabs: 1,
      totalTabs: 3
    }));
    expect(chrome.storage.session.remove.mock.invocationCallOrder[0])
      .toBeLessThan(chrome.storage.session.set.mock.invocationCallOrder.at(-1));
  });

  test('records a cancelled run left unfinished by a stopped worker as cancelled', async () => {
    sessionStore.refreshOperationState = {
      active: true,
      currentTabs: [{ id: 73, title: 'One', url: 'https://example.com/one' }],
      processedTabs: 0,
      refreshedTabs: 0,
      cancelled: true
    };

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    const historyWrite = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .filter(Boolean)
      .at(-1);
    expect(historyWrite[0]).toEqual(expect.objectContaining({ cancelled: true }));
    expect(historyWrite[0].interrupted).toBeUndefined();
    expect(sessionStore.refreshOperationState).toBeUndefined();
  });

  test('reports an interrupted run to one popup and then forgets it', () => {
    sessionStore.refreshOperationState = {
      active: false,
      interrupted: true,
      progress: 33,
      totalTabs: 3,
      processedTabs: 1
    };
    const { onMessage } = executeBackgroundJs();
    const firstResponse = jest.fn();
    const secondResponse = jest.fn();

    onMessage({ action: 'getOperationStatus' }, {}, firstResponse);
    onMessage({ action: 'getOperationStatus' }, {}, secondResponse);

    expect(firstResponse).toHaveBeenCalledWith(expect.objectContaining({ interrupted: true, progress: 33 }));
    expect(secondResponse).toHaveBeenCalledWith(expect.objectContaining({ active: false, interrupted: false }));
    expect(sessionStore.refreshOperationState).toBeUndefined();
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
        startTime: 'not a date'
      }
    }));

    expect(() => executeBackgroundJs()).not.toThrow();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      refreshOperationState: expect.objectContaining({ active: false, interrupted: true })
    }, expect.any(Function));
  });

  test('filters malformed tab records before recording an interrupted operation', async () => {
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
        startTime: '2026-08-27T09:00:00.000Z'
      }
    }));

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      details: expect.objectContaining({ totalTabs: 1, failedCount: 0, skippedCount: 1 }),
      failedTabs: []
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
      singleTab: false,
      incognito: false,
      lastUpdated: expect.any(String)
    });
  });

  describe('a worker woken while a stopped run is still stored as active', () => {
    let pendingReads;

    // Chrome answers storage reads in the order they were issued, each from the
    // state at that point, and only after the current task ends.
    beforeEach(() => {
      pendingReads = [];
      chrome.storage.session.get.mockImplementation((keys, callback) => {
        const snapshot = Object.fromEntries(keys
          .filter(key => Object.hasOwn(sessionStore, key))
          .map(key => [key, sessionStore[key]]));
        pendingReads.push(() => callback(snapshot));
      });
      sessionStore.refreshOperationState = {
        active: true,
        generation: 5,
        currentTabs: [70, 71, 72].map(id => ({ id, title: `Tab ${id}`, url: `https://example.com/${id}` })),
        processedTabs: 1,
        refreshedTabs: 1,
        failedTabDetails: [],
        skippedTabIds: [],
        tabStatuses: { 70: 'success', 71: 'pending', 72: 'pending' },
        cancelled: false,
        staleBytes: 0,
        startTime: '2026-10-15T09:00:00.000Z'
      };
    });

    async function answerReads() {
      for (let round = 0; round < 20; round++) {
        while (pendingReads.length) pendingReads.shift()();
        await jest.advanceTimersByTimeAsync(0);
      }
    }

    test('answers the waking status request with the interruption, not a live run', async () => {
      const { onMessage } = executeBackgroundJs();
      const respond = jest.fn();

      onMessage({ action: 'getOperationStatus' }, {}, respond);
      await answerReads();

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ active: false, interrupted: true, processedTabs: 1 }));
      expect(sessionStore.refreshOperationState).toBeUndefined();
    });

    test('records the stopped run in history before a waking refresh request claims the worker', async () => {
      chrome.tabs.query.mockImplementation((query, callback) => callback([
        { id: 9, title: 'New', url: 'https://example.com/new', discarded: false }
      ]));
      const { onMessage } = executeBackgroundJs();

      onMessage({ action: 'startRefresh' }, {}, jest.fn());
      await answerReads();
      await jest.runAllTimersAsync();
      await answerReads();

      const savedEntries = chrome.storage.local.set.mock.calls
        .map(([value]) => value.refreshHistory?.[0])
        .filter(Boolean);
      expect(savedEntries).toEqual([
        expect.objectContaining({ totalTabs: 3, successfulTabs: 1, interrupted: true }),
        expect.objectContaining({ totalTabs: 1, successfulTabs: 1 })
      ]);
      expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([9]);
    });
  });

  test('marks the completion message of an interrupted run as interrupted', async () => {
    sessionStore.refreshOperationState = {
      active: true,
      currentTabs: [{ id: 74, title: 'One', url: 'https://example.com/one' }],
      processedTabs: 0,
      refreshedTabs: 0,
      cancelled: false
    };

    executeBackgroundJs();
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete',
      details: expect.objectContaining({ interrupted: true, cancelled: false })
    }));
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

  test('starts each worker lifetime above the generations the previous worker used', async () => {
    jest.setSystemTime(new Date('2026-10-15T09:00:00.000Z'));
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 130, title: 'One', url: 'https://example.com/one', discarded: false }
    ]));
    const startedGenerations = () => chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'refreshStarted')
      .map(message => message.generation);

    let { onMessage } = executeBackgroundJs();
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();
    // Chrome stops an idle worker after about 30 seconds; the next event starts a new one.
    jest.advanceTimersByTime(30000);
    ({ onMessage } = executeBackgroundJs());
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    const [first, second, third] = startedGenerations();
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  test('refreshes only tabs whose incognito mode matches the window that asked', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 131, incognito: false, title: 'Normal', url: 'https://example.com/normal', discarded: false },
      { id: 132, incognito: true, title: 'Private', url: 'https://example.com/private', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();
    const startedTabIds = () => chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'refreshStarted')
      .at(-1).tabs.map(tab => tab.id);

    onMessage({ action: 'startRefresh', incognito: false }, {}, jest.fn());
    await jest.runAllTimersAsync();
    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([131]);
    expect(startedTabIds()).toEqual([131]);

    chrome.tabs.reload.mockClear();
    onMessage({ action: 'startRefresh', incognito: true }, {}, jest.fn());
    await jest.runAllTimersAsync();
    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([132]);
    expect(startedTabIds()).toEqual([132]);
  });

  test('keeps a run out of the status and cancel answers for a window of the other kind', async () => {
    chrome.scripting.executeScript.mockImplementation(() => {});
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 131, incognito: false, title: 'Normal', url: 'https://example.com/normal', discarded: false },
      { id: 132, incognito: true, title: 'Private statement', url: 'https://bank.example/private', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh', incognito: true }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(0);

    const normalStatus = jest.fn();
    onMessage({ action: 'getOperationStatus', incognito: false }, {}, normalStatus);
    expect(normalStatus).toHaveBeenCalledWith({ active: false });

    const normalCancel = jest.fn();
    onMessage({ action: 'cancelOperation', incognito: false }, {}, normalCancel);
    expect(normalCancel).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

    const privateStatus = jest.fn();
    onMessage({ action: 'getOperationStatus', incognito: true }, {}, privateStatus);
    expect(privateStatus).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      currentTabs: [expect.objectContaining({ id: 132 })]
    }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshStarted', incognito: true
    }));

    const privateCancel = jest.fn();
    onMessage({ action: 'cancelOperation', incognito: true }, {}, privateCancel);
    await jest.runAllTimersAsync();
    expect(privateCancel).toHaveBeenCalledWith({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete', incognito: true
    }));
  });

  test('reports an interrupted incognito run only to an incognito window', async () => {
    sessionStore.refreshOperationState = {
      active: true,
      incognito: true,
      currentTabs: [{ id: 133, incognito: true, title: 'Private', url: 'https://example.com/private' }],
      processedTabs: 0,
      refreshedTabs: 0,
      cancelled: false
    };
    const { onMessage } = executeBackgroundJs();
    await jest.runAllTimersAsync();

    const normalStatus = jest.fn();
    onMessage({ action: 'getOperationStatus', incognito: false }, {}, normalStatus);
    const privateStatus = jest.fn();
    onMessage({ action: 'getOperationStatus', incognito: true }, {}, privateStatus);

    expect(normalStatus).toHaveBeenCalledWith({ active: false });
    expect(privateStatus).toHaveBeenCalledWith(expect.objectContaining({ interrupted: true, incognito: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'refreshComplete', incognito: true
    }));
  });

  test('reloads a tab without media capture when the page does not answer in three seconds', async () => {
    let lateCaptureCallback;
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 133, title: 'Hung', url: 'https://example.com/hung', discarded: false },
      { id: 134, title: 'Next', url: 'https://example.com/next', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      if (details.target.tabId === 133) {
        lateCaptureCallback = callback;
        return;
      }
      callback([{ result: { success: true, count: 0, staleBytes: 0 } }]);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(2999);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([133]);

    lateCaptureCallback([{ result: { success: true, count: 1, staleBytes: 5 } }]);
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([133, 134]);
    const completion = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'refreshComplete');
    expect(completion.details).toEqual(expect.objectContaining({ failedCount: 0, staleBytes: 0 }));
  });

  test('records a tab whose reload never answers as timed out and moves on', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 133, title: 'Hung', url: 'https://example.com/hung', discarded: false },
      { id: 134, title: 'Next', url: 'https://example.com/next', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      callback([{ result: { success: true, count: 0, staleBytes: 0 } }]);
    });
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      if (tabId !== 133) callback();
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([133, 134]);
    const completion = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'refreshComplete');
    expect(completion.details).toEqual(expect.objectContaining({ failedCount: 1, successfulTabs: 1 }));
  });

  test('reloads the tab under the popup last', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 150, title: 'Active', url: 'https://example.com/active', discarded: true },
      { id: 151, title: 'Two', url: 'https://example.com/two', discarded: true },
      { id: 152, title: 'Three', url: 'https://example.com/three', discarded: true }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh', incognito: false, activeTabId: 150 }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([151, 152, 150]);
  });

  test.each([
    ['a clean run', [], '\u2713', '#15964a'],
    ['a run with a failure', ['fail'], '!', '#c62828']
  ])('shows the result of %s on the toolbar badge for a few seconds', async (_case, failures, text, color) => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 160, title: 'One', url: 'https://example.com/one', discarded: true }
    ]));
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      if (failures.length) setRuntimeLastError({ message: 'Reload failed' });
      callback();
      setRuntimeLastError(undefined);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.advanceTimersByTimeAsync(3000);

    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color });
    await jest.advanceTimersByTimeAsync(4000);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  test('clears the badge after a cancelled run', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 170, title: 'One', url: 'https://example.com/one', discarded: true },
      { id: 171, title: 'Two', url: 'https://example.com/two', discarded: true }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  test('refreshes only the requested tab through the shared run path', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 140, title: 'Other', url: 'https://example.com/other', discarded: false },
      { id: 141, title: 'Active', url: 'https://example.com/active', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      callback([{ result: { success: true, count: 0, staleBytes: 7 } }]);
    });
    const { onMessage } = executeBackgroundJs();
    const sendResponse = jest.fn();

    onMessage({ action: 'startRefresh', incognito: false, tabId: 141 }, {}, sendResponse);
    const concurrent = jest.fn();
    onMessage({ action: 'startRefresh', incognito: false }, {}, concurrent);
    await jest.runAllTimersAsync();

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect(concurrent).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(chrome.tabs.reload.mock.calls.map(([tabId]) => tabId)).toEqual([141]);
    const messages = chrome.runtime.sendMessage.mock.calls.map(([message]) => message);
    expect(messages.find(message => message.action === 'refreshStarted'))
      .toEqual(expect.objectContaining({ singleTab: true, tabs: [expect.objectContaining({ id: 141 })] }));
    expect(messages.find(message => message.action === 'refreshComplete').details)
      .toEqual(expect.objectContaining({ singleTab: true, totalTabs: 1, successfulTabs: 1, staleBytes: 7 }));
    const historyWrite = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .find(Boolean);
    expect(historyWrite[0]).toEqual(expect.objectContaining({ singleTab: true, totalTabs: 1 }));
  });

  test('counts stale bytes once per tab when a reload is retried', async () => {
    let reloadAttempts = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 135, title: 'Flaky', url: 'https://example.com/flaky', discarded: false }
    ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      callback([{ result: { success: true, count: 0, staleBytes: 5 } }]);
    });
    chrome.tabs.reload.mockImplementation((tabId, options, callback) => {
      if (reloadAttempts++ === 0) setRuntimeLastError({ message: 'Reload failed' });
      callback();
      setRuntimeLastError(undefined);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    expect(reloadAttempts).toBe(2);
    const completion = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.action === 'refreshComplete');
    expect(completion.details).toEqual(expect.objectContaining({ successfulTabs: 1, staleBytes: 5 }));
  });

  test('records a run cancelled during the permission lookup without the previous run\'s counts', async () => {
    const cacheWrites = [];
    let resolveSecondPermission;
    let permissionCalls = 0;
    chrome.permissions.contains.mockImplementation(() => (permissionCalls++ === 0
      ? Promise.resolve(true)
      : new Promise(resolve => { resolveSecondPermission = resolve; })));
    const localStore = { refreshHistory: [] };
    chrome.storage.local.get.mockImplementation((keys, callback) => callback({ ...localStore }));
    chrome.storage.local.set.mockImplementation((data, callback) => {
      Object.assign(localStore, data);
      if (data.cacheStats) cacheWrites.push(data.cacheStats);
      callback?.();
    });
    let queryCount = 0;
    chrome.tabs.query.mockImplementation((query, callback) => callback(queryCount++ === 0
      ? [{ id: 136, title: 'First', url: 'https://example.com/first', discarded: false }]
      : [
        { id: 137, title: 'Second', url: 'https://example.com/second', discarded: false },
        { id: 138, title: 'Third', url: 'https://example.com/third', discarded: false }
      ]));
    chrome.scripting.executeScript.mockImplementation((details, callback) => {
      callback([{ result: { success: true, count: 0, staleBytes: 10 } }]);
    });
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await Promise.resolve();
    expect(resolveSecondPermission).toEqual(expect.any(Function));
    onMessage({ action: 'cancelOperation' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    const completions = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === 'refreshComplete');
    expect(completions.at(-1).details).toEqual(expect.objectContaining({
      cancelled: true,
      successfulTabs: 0,
      staleBytes: 0
    }));
    expect(cacheWrites.at(-1)).toEqual(expect.objectContaining({ lastRun: 0, total: 10 }));
  });

  test('keeps finishing runs when stored history is not a list', async () => {
    chrome.storage.local.get.mockImplementation((keys, callback) => callback({
      refreshHistory: { bad: true }
    }));
    chrome.tabs.query.mockImplementation((query, callback) => callback([
      { id: 139, title: 'One', url: 'https://example.com/one', discarded: false }
    ]));
    const { onMessage } = executeBackgroundJs();

    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();
    onMessage({ action: 'startRefresh' }, {}, jest.fn());
    await jest.runAllTimersAsync();

    const completions = chrome.runtime.sendMessage.mock.calls
      .filter(([message]) => message.action === 'refreshComplete');
    expect(completions).toHaveLength(2);
    const historyWrite = chrome.storage.local.set.mock.calls
      .map(([value]) => value.refreshHistory)
      .filter(Boolean)
      .at(-1);
    expect(historyWrite).toEqual([expect.objectContaining({ successfulTabs: 1 })]);
  });

  test('does not write pending media restores when a page load changes nothing', async () => {
    const { onUpdated } = executeBackgroundJs();
    chrome.storage.session.set.mockClear();

    await onUpdated(140, { status: 'complete' });
    await onUpdated(141, { status: 'complete' });

    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });
});
