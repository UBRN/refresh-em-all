const fs = require('fs');
const path = require('path');
const { executePopupJs, popupHtml, popupSource, repositoryRoot } = require('./popup-harness');

const $ = id => document.getElementById(id);
const state = () => document.body.dataset.state;
const visible = element => element.closest('.slot > .v')?.classList.contains('on') ?? true;
const settle = (ms = 0) => jest.advanceTimersByTimeAsync(ms);
const fillPercent = () => {
  const match = $('progressFill').style.transform.match(/translateX\((-?[\d.]+)%\)/);
  return match ? 100 + Number(match[1]) : 0;
};
const tabs = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, title: `Tab ${index + 1}` }));

function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('Popup markup contract', () => {
  test('every element id popup.js looks up exists in popup.html', () => {
    const ids = new Set([
      ...[...popupSource.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]),
      ...[...popupSource.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1])
    ]);
    const document = new DOMParser().parseFromString(popupHtml, 'text/html');

    expect(ids.size).toBeGreaterThan(30);
    for (const id of ids) expect(`#${id}: ${Boolean(document.getElementById(id))}`).toBe(`#${id}: true`);
  });

  test('every catalog key named in popup.html exists', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '_locales/en/messages.json'), 'utf8'));
    const keys = [...popupHtml.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)].map(match => match[1]);

    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(catalog).toHaveProperty(key);
  });

  test('the popup and the worker skip the same restricted URL schemes', () => {
    const background = fs.readFileSync(path.join(repositoryRoot, 'background.js'), 'utf8');
    const list = source => [...source.match(/isRestrictedTabUrl[\s\S]*?\]/)[0].matchAll(/'([a-z-]+:)'/g)]
      .map(match => match[1]);
    const popupList = [...popupSource.match(/RESTRICTED_URL_PREFIXES = \[[\s\S]*?\]/)[0].matchAll(/'([a-z-]+:)'/g)]
      .map(match => match[1]);

    expect(popupList.length).toBeGreaterThan(5);
    expect(popupList).toEqual(list(background));
  });
});

describe('Popup controller', () => {
  let getContext;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    getContext.mockRestore();
    delete document.visibilityState;
    jest.useRealTimers();
    resetTestEnvironment();
  });

  test('starts a refresh through the background worker and disables duplicate starts', async () => {
    const onMessage = executePopupJs();
    await settle();
    expect($('refreshAll').disabled).toBe(false);

    $('refreshAll').click();
    $('refreshAll').click();

    const starts = chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'startRefresh');
    expect(starts).toEqual([[{ action: 'startRefresh', incognito: false, activeTabId: 7 }, expect.any(Function)]]);
    expect($('refreshAll').disabled).toBe(true);

    onMessage({ action: 'refreshStarted', generation: 2, tabs: tabs(4) });
    expect(state()).toBe('running');
    expect(visible($('cancelRefresh'))).toBe(true);
    expect($('runTotal').textContent).toBe('of 4 tabs');
    expect($('tabDots').children).toHaveLength(4);
  });

  test('starts a refresh limited to incognito tabs from an incognito window', async () => {
    executePopupJs({ incognito: true });
    await settle();

    $('refreshAll').click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh', incognito: true, activeTabId: 7 },
      expect.any(Function)
    );
    expect($('readySub').textContent).toBe('Across your incognito windows');
  });

  test('asks about and cancels only runs of its own window kind', async () => {
    const onMessage = executePopupJs({ incognito: true });
    await settle();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'getOperationStatus', incognito: true },
      expect.any(Function)
    );

    onMessage({ action: 'refreshStarted', generation: 2, incognito: true, tabs: tabs(2) });
    $('cancelRefresh').click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'cancelOperation', incognito: true },
      expect.any(Function)
    );
  });

  test('ignores the broadcasts of a run in a window of the other kind', async () => {
    const onMessage = executePopupJs();
    await settle();

    onMessage({ action: 'refreshStarted', generation: 2, incognito: true, singleTab: true, tabs: [{ id: 132, title: 'Private statement', url: 'https://bank.example/private' }] });
    onMessage({ action: 'refreshProgress', generation: 2, incognito: true, current: 1, total: 1, percent: 100 });
    onMessage({
      action: 'refreshComplete', generation: 2, incognito: true, success: false,
      details: { totalTabs: 1, processedTabs: 1, successfulTabs: 0, failedCount: 1 },
      failedTabs: [{ id: 132, title: 'Private statement', error: 'Failed' }]
    });
    await settle(1500);

    expect(state()).toBe('ready');
    expect(document.body.textContent).not.toContain('Private statement');
    expect(document.body.textContent).not.toContain('bank.example');
  });

  test('says a reload is already running when the running one is in a window of the other kind', async () => {
    executePopupJs();
    await settle();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.action === 'startRefresh') callback({ success: false, message: 'Your tabs are already being reloaded' });
      else if (message.action === 'getOperationStatus') callback({ active: false });
      return Promise.resolve({});
    });

    $('refreshAll').click();
    await settle();

    expect(state()).toBe('failed');
    expect($('failSub').textContent).toBe('Your tabs are already being reloaded');
    expect($('refreshAll').disabled).toBe(false);
  });

  test('requests optional page-reading permission from the settings view', async () => {
    executePopupJs({ siteAccess: false, requestAccessResult: true });
    await settle();
    expect($('accessPill').textContent).toBe('Off');

    $('openSettings').click();
    $('grantAccess').click();
    await settle();

    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect($('accessPill').textContent).toBe('On');
    expect($('grantAccess').hidden).toBe(true);
    expect($('metaSettings').textContent).toBe('Page reading on');
  });

  test('first refresh asks in the popup before Chrome does, and still starts when refused', async () => {
    executePopupJs({ siteAccess: false, mediaAccessAsked: false, requestAccessResult: false });
    await settle();

    $('refreshAll').click();
    expect(state()).toBe('ask');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'startRefresh' }), expect.anything());

    $('allowAndRefresh').click();
    await settle();

    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ mediaAccessAsked: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh', incognito: false, activeTabId: 7 },
      expect.any(Function)
    );
  });

  test('"Just refresh" starts without the permission and does not ask again', async () => {
    executePopupJs({ siteAccess: false, mediaAccessAsked: false });
    await settle();

    $('refreshAll').click();
    $('justRefresh').click();

    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ mediaAccessAsked: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh', incognito: false, activeTabId: 7 },
      expect.any(Function)
    );
  });

  test('keeps refresh disabled during initialization and a pending permission request', async () => {
    let finishInitialization;
    let refusePermission;
    executePopupJs({
      siteAccess: new Promise(resolve => { finishInitialization = resolve; }),
      requestAccessResult: new Promise(resolve => { refusePermission = resolve; })
    });

    expect($('refreshAll').disabled).toBe(true);
    finishInitialization(false);
    await settle();
    expect($('refreshAll').disabled).toBe(false);

    $('grantAccess').click();
    expect($('refreshAll').disabled).toBe(true);
    refusePermission(false);
    await settle();
    expect($('refreshAll').disabled).toBe(false);
  });

  test('a later refresh does not ask for access', async () => {
    executePopupJs({ siteAccess: false, mediaAccessAsked: true });
    await settle();

    $('refreshAll').click();

    expect(state()).toBe('ready');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh', incognito: false, activeTabId: 7 },
      expect.any(Function)
    );
  });

  test.each([
    [true, true, 'On'],
    [false, false, 'Off']
  ])('renders optional-access controls for granted=%s', async (siteAccess, hidden, pill) => {
    executePopupJs({ siteAccess });
    await settle();

    expect($('grantAccess').hidden).toBe(hidden);
    expect($('statsAccessHint').hidden).toBe(hidden);
    expect($('accessPill').textContent).toBe(pill);
  });

  test('renders per-tab results and keeps aria-valuenow on the real value', async () => {
    const onMessage = executePopupJs();
    await settle();

    onMessage({ action: 'refreshStarted', tabs: tabs(4) });
    onMessage({ action: 'tabSucceeded', tabId: 1 });
    onMessage({ action: 'tabFailed', tabId: 2, error: 'Reload failed' });
    onMessage({ action: 'tabSkipped', tabId: 3 });
    onMessage({ action: 'refreshProgress', current: 3, total: 4, percent: 75, successful: 1, failed: 1, skipped: 1 });
    await settle(5000);

    const dots = [...$('tabDots').children].map(dot => dot.dataset.status);
    expect(dots).toEqual(['success', 'error', 'skipped', undefined]);
    expect($('progressBar').getAttribute('aria-valuenow')).toBe('75');
    expect($('countReloaded').textContent).toBe('1');
    expect($('chipFailed').hidden).toBe(false);
    expect($('chipSkipped').hidden).toBe(false);

    onMessage({
      action: 'refreshComplete', success: false,
      details: { totalTabs: 4, processedTabs: 4, successfulTabs: 2, failedCount: 1, skippedCount: 1 },
      failedTabs: [{ id: 2, title: 'Two', error: 'Reload failed' }]
    });
    await settle(1000);

    expect(state()).toBe('failed');
    expect($('progressBar').getAttribute('aria-valuenow')).toBe('100');
    expect($('failTitle').textContent).toBe('Failed to reload 1 tab.');
    expect($('failedList').textContent).toBe('TwoReload failed');
    expect($('statusText').textContent).toBe('Failed to reload 1 tab.');
  });

  test('the bar creeps while a tab is in flight but never passes the next step or goes back', async () => {
    const onMessage = executePopupJs();
    await settle();

    onMessage({ action: 'refreshStarted', tabs: tabs(4) });
    onMessage({ action: 'refreshProgress', current: 1, total: 4, percent: 25, successful: 1, failed: 0, skipped: 0 });
    await settle(300);
    const early = fillPercent();
    await settle(20000);
    const late = fillPercent();

    expect(early).toBeGreaterThanOrEqual(24);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(25 + 0.9 * 25 + 0.01);
    // The visible numbers never claim the tab still in flight.
    expect($('progressPercent').textContent).toBe('25%');
    expect($('runCount').textContent).toBe('1');
    expect($('progressBar').getAttribute('aria-valuenow')).toBe('25');
  });

  test('stops the animation loop while the popup is hidden', async () => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', tabs: tabs(4) });
    onMessage({ action: 'refreshProgress', current: 1, total: 4, percent: 25, successful: 1, failed: 0, skipped: 0 });
    await settle(200);

    setVisibility('hidden');
    const frozen = $('progressFill').style.transform;
    await settle(5000);

    expect($('progressFill').style.transform).toBe(frozen);
  });

  test('announces milestones at quarters, not on every tab', async () => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', tabs: tabs(8) });
    const announcements = [];
    const observer = { record: () => announcements.push($('statusText').textContent) };

    expect($('statusText').textContent).toBe('0 of 8 tabs done…');
    for (let current = 1; current <= 7; current++) {
      onMessage({ action: 'refreshProgress', current, total: 8, percent: Math.floor(current / 8 * 100), successful: current, failed: 0, skipped: 0 });
      observer.record();
    }

    expect([...new Set(announcements)]).toEqual(['0 of 8 tabs done…', '2 of 8 tabs done', '4 of 8 tabs done', '6 of 8 tabs done']);
  });

  test('ignores a failed cancel callback after the operation completes', async () => {
    const onMessage = executePopupJs();
    await settle();
    let cancelCallback;
    onMessage({ action: 'refreshStarted', tabs: tabs(1) });
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.action === 'cancelOperation') cancelCallback = callback;
    });

    $('cancelRefresh').click();
    expect($('trackText').textContent).toBe('Stopping…');
    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1, cancelled: true }
    });
    await settle(1000);
    cancelCallback({ success: false });

    expect(state()).toBe('stopped');
    expect($('stopTitle').textContent).toBe('Stopped after 1 of 1 tabs.');
  });

  test('ignores a completion message from an older operation generation', async () => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', generation: 5, tabs: tabs(1) });

    onMessage({
      action: 'refreshComplete', generation: 4, success: true,
      details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1 }
    });
    await settle(1000);

    expect(state()).toBe('running');
    expect($('refreshAll').disabled).toBe(true);
  });

  test('ignores old progress after restoring a newer operation generation', async () => {
    const onMessage = executePopupJs({
      operationState: {
        active: true,
        generation: 8,
        currentTabs: [{ id: 21, title: 'Restored' }, { id: 22, title: 'Next' }],
        tabStatuses: { 21: 'success', 22: 'pending' },
        processedTabs: 1,
        totalTabs: 2,
        progress: 50,
        refreshedTabs: 1,
        failedTabs: 0,
        skippedTabs: 0
      }
    });
    await settle();

    onMessage({ action: 'refreshProgress', generation: 7, current: 2, total: 2, percent: 100, successful: 2, failed: 0, skipped: 0 });

    expect($('progressBar').getAttribute('aria-valuenow')).toBe('50');
    expect($('countReloaded').textContent).toBe('1');
  });

  test('accepts a completion message without a generation field', async () => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', generation: 9, tabs: tabs(2) });

    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 2, processedTabs: 2, successfulTabs: 2 }
    });
    await settle(1000);

    expect(state()).toBe('done');
    expect($('refreshAll').disabled).toBe(false);
    expect($('doneTitle').textContent).toBe(chrome.i18n.getMessage('statusCompleteAll', ['2']));
  });

  test('a stopped run keeps failures in the counts and quiets the tabs that never ran', async () => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', tabs: tabs(3) });
    onMessage({ action: 'tabSucceeded', tabId: 1 });
    onMessage({ action: 'tabFailed', tabId: 2 });

    onMessage({
      action: 'refreshComplete', success: false,
      details: { totalTabs: 3, processedTabs: 2, successfulTabs: 1, failedCount: 1, cancelled: true },
      failedTabs: [{ id: 2, title: 'Two', error: 'Reload failed before cancellation' }]
    });
    await settle(500);

    expect(state()).toBe('stopped');
    expect($('stopTitle').textContent).toBe(chrome.i18n.getMessage('statusCancelled', ['2', '3']));
    expect($('countFailed').textContent).toBe('1');
    expect($('tabDots').classList.contains('settled')).toBe(true);
    expect(document.querySelector('.sheen')).not.toBeNull();
  });

  test('restores an active operation when the popup is reopened', async () => {
    executePopupJs({
      operationState: {
        active: true,
        currentTabs: [{ id: 9, title: 'Restored' }, { id: 10, title: 'Next' }],
        tabStatuses: { 9: 'success' },
        processedTabs: 1,
        totalTabs: 2,
        progress: 50,
        refreshedTabs: 1,
        failedTabs: 0,
        skippedTabs: 0
      }
    });
    await settle();

    expect(state()).toBe('running');
    expect($('progressBar').getAttribute('aria-valuenow')).toBe('50');
    expect($('tabDots').children[0].dataset.status).toBe('success');
    expect($('refreshAll').disabled).toBe(true);
  });

  test('reports an interrupted run once, as stopped, with its progress', async () => {
    executePopupJs({
      operationState: { active: false, interrupted: true, progress: 40, processedTabs: 2, totalTabs: 5, refreshedTabs: 2 }
    });
    await settle();

    expect(state()).toBe('stopped');
    expect($('stopTitle').textContent).toBe('The last reload stopped before it finished.');
    expect($('progressBar').getAttribute('aria-valuenow')).toBe('40');
    expect($('countReloaded').textContent).toBe('2');
  });

  test('a run whose worker stopped midway ends as interrupted, without confetti', async () => {
    const onMessage = executePopupJs({
      operationState: { active: true, generation: 1000, processedTabs: 5, refreshedTabs: 5, currentTabs: tabs(20), tabStatuses: {} }
    });
    await settle();
    $('cancelRefresh').focus();
    expect(state()).toBe('running');

    onMessage({
      action: 'refreshComplete', generation: 2000, success: false,
      details: { totalTabs: 20, processedTabs: 5, successfulTabs: 5, failedCount: 0, skippedCount: 0, cancelled: false, interrupted: true },
      failedTabs: []
    });
    await settle(1500);

    expect(state()).toBe('stopped');
    expect($('stopTitle').textContent).toBe('The last reload stopped before it finished.');
    expect($('progressBar').getAttribute('aria-valuenow')).toBe('25');
    expect(document.activeElement).toBe($('refreshAll'));
    expect(getContext).not.toHaveBeenCalled();
  });

  test('keeps the start reason when the worker also reports a zero-tab run', async () => {
    const onMessage = executePopupJs();
    await settle();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.action === 'startRefresh') callback({ success: false, message: 'There are no tabs to reload' });
    });

    $('refreshAll').click();
    onMessage({
      action: 'refreshComplete', success: false,
      details: { totalTabs: 0, processedTabs: 0, successfulTabs: 0, failedCount: 1 },
      failedTabs: [{ title: 'Could not start', error: 'There are no tabs to reload' }]
    });

    expect(state()).toBe('failed');
    expect($('failTitle').textContent).toBe('Could not start');
    expect($('failSub').textContent).toBe('There are no tabs to reload');
    expect($('failedList').hidden).toBe(true);
    expect($('refreshAll').disabled).toBe(false);
  });

  test('moves focus to Refresh when the this-tab reload cannot start', async () => {
    executePopupJs();
    await settle();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.action === 'startRefresh') {
        Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, value: { message: 'Could not establish connection' } });
        callback();
        Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, value: undefined });
      }
      return Promise.resolve({});
    });

    $('refreshThisTab').focus();
    $('refreshThisTab').click();
    await settle();

    expect(state()).toBe('failed');
    expect(document.activeElement).toBe($('refreshAll'));
  });

  test.each([
    ['a clean run', { totalTabs: 3, processedTabs: 3, successfulTabs: 3 }, true],
    ['skipped browser pages', { totalTabs: 3, processedTabs: 3, successfulTabs: 2, skippedCount: 1 }, true],
    ['nothing reloaded', { totalTabs: 2, processedTabs: 2, successfulTabs: 0, skippedCount: 2 }, false],
    ['cancellation', { totalTabs: 3, processedTabs: 2, successfulTabs: 2, cancelled: true }, false],
    ['failures', { totalTabs: 3, processedTabs: 3, successfulTabs: 2, failedCount: 1 }, false],
    ['a single tab', { totalTabs: 1, processedTabs: 1, successfulTabs: 1, singleTab: true }, false]
  ])('confetti after %s: %s', async (_case, details, expected) => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', singleTab: details.singleTab === true, tabs: tabs(details.totalTabs) });

    onMessage({ action: 'refreshComplete', details, failedTabs: details.failedCount ? [{ title: 'x', error: 'y' }] : [] });
    await settle(1500);

    expect(getContext.mock.calls.length > 0).toBe(expected);
  });

  test('no confetti when the popup is hidden or only reopened over a finished run', async () => {
    let onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', tabs: tabs(2) });
    setVisibility('hidden');
    onMessage({ action: 'refreshComplete', details: { totalTabs: 2, processedTabs: 2, successfulTabs: 2 } });
    await settle(1500);
    expect(state()).toBe('done');
    expect(getContext).not.toHaveBeenCalled();

    setVisibility('visible');
    onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshComplete', details: { totalTabs: 2, processedTabs: 2, successfulTabs: 2 } });
    await settle(1500);
    expect(getContext).not.toHaveBeenCalled();
  });

  test('moves keyboard focus to Cancel when a run starts and back to Refresh when it ends', async () => {
    const onMessage = executePopupJs();
    await settle();
    $('refreshAll').focus();

    $('refreshAll').click();
    onMessage({ action: 'refreshStarted', tabs: tabs(1) });
    expect(document.activeElement).toBe($('cancelRefresh'));

    onMessage({ action: 'refreshComplete', details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1 } });
    await settle(1500);
    expect(document.activeElement).toBe($('refreshAll'));
  });

  test('opens a sub view from the list and returns focus to its row', async () => {
    executePopupJs();
    await settle();

    $('openHistory').click();
    expect($('subView').classList.contains('on')).toBe(true);
    expect($('subTitle').textContent).toBe('Recent reloads');
    expect(document.activeElement).toBe($('back'));

    $('back').click();
    expect($('homeView').classList.contains('on')).toBe(true);
    expect(document.activeElement).toBe($('openHistory'));
  });

  test('renders sanitized local history with relative times', async () => {
    jest.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
    executePopupJs({
      history: [{
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTabs: 4,
        successfulTabs: 2,
        failedCount: 1,
        skippedCount: 1,
        cancelled: false
      }, {
        timestamp: '2025-12-31T02:00:00.000Z',
        totalTabs: 1,
        successfulTabs: 1,
        singleTab: true
      }, {
        timestamp: '<img src=x onerror=alert(1)>',
        totalTabs: 5,
        successfulTabs: 2,
        interrupted: true
      }]
    });
    await settle();
    $('openHistory').click();

    const rows = [...$('historyList').children].map(row => row.textContent);
    expect(rows).toEqual([
      '2 of 4 reloaded2 hours ago1 failed, 1 skipped',
      '1 of 1 reloadedyesterdayThis tab',
      'Interrupted: 2 of 5 reloadedUnknown dateInterrupted before the end'
    ]);
    expect($('historyList').querySelector('img')).toBeNull();
    expect($('metaHistory').textContent).toBe('2 hours ago');
    expect($('readySub').textContent).toBe('Last reload 2 hours ago: 2 of 4 reloaded');
  });

  test('shows estimates for the measured totals', async () => {
    jest.setSystemTime(new Date(2026, 7, 24, 12));
    executePopupJs({
      cacheStats: {
        lastRun: 1536,
        total: 10 * 1024 * 1024,
        days: { '2026-08-24': 2048, '2026-08-23': 3072, '2026-08-22': 4096, '2026-08-01': 1024 }
      }
    });
    await settle();

    expect($('statsToday').textContent).toBe('about2.0 KB');
    expect($('statsLastRun').textContent).toBe('about1.5 KB');
    expect($('statsWeek').textContent).toBe('about9.0 KB');
    expect($('statsMonth').textContent).toBe('about10.0 KB');
    expect($('statsTotal').textContent).toBe('10.0 MB');
    expect($('metaFiles').textContent).toBe('≈ 10.0 MB');
  });

  test('resets statistics and Undo brings them back, keeping bytes measured since', async () => {
    const onMessage = executePopupJs({ cacheStats: { lastRun: 10, total: 100, days: { '2026-08-24': 100 } } });
    await settle();
    $('openSettings').click();

    $('resetStats').click();
    expect(onMessage.storage.cacheStats).toBeUndefined();
    expect($('undoReset').hidden).toBe(false);

    onMessage.storage.cacheStats = { lastRun: 5, total: 5, days: { '2026-08-24': 5 } };
    $('undoResetButton').click();

    expect(onMessage.storage.cacheStats).toEqual({ lastRun: 5, total: 105, days: { '2026-08-24': 105 } });
    expect($('undoReset').hidden).toBe(true);
  });

  test('the Undo offer is announced and ends after six seconds unless it has focus', async () => {
    executePopupJs({ cacheStats: { lastRun: 10, total: 100, days: {} } });
    await settle();
    $('openSettings').click();

    $('resetStats').focus();
    $('resetStats').click();
    expect($('statusText').textContent).toBe('Statistics reset.');
    expect(document.activeElement).toBe($('undoResetButton'));
    await settle(12000);
    expect($('undoReset').hidden).toBe(false);

    $('back').focus();
    await settle(6000);
    expect($('undoReset').hidden).toBe(true);
    expect($('resetStats').hidden).toBe(false);
  });

  test('shows measured stale bytes on completion and clears them on the next run', async () => {
    const onMessage = executePopupJs();
    await settle();
    onMessage({ action: 'refreshStarted', tabs: tabs(1) });
    onMessage({ action: 'refreshComplete', details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1, staleBytes: 2048 } });
    await settle(2000);

    expect($('footDone').textContent)
      .toBe('About 2.0 KB came from copies Chrome saved earlier and was downloaded again, so pages show their newest version.');

    onMessage({ action: 'refreshStarted', tabs: tabs(1) });
    expect($('footDone').textContent).toBe('');
  });

  test('offers this tab by its site and reloads only that tab', async () => {
    const onMessage = executePopupJs();
    await settle();

    expect($('refreshThisTab').disabled).toBe(false);
    expect($('thisTabSite').textContent).toBe('youtube.com');
    expect($('thisTabNote').textContent).toBe('Fetches fresh files. Videos pick up where they left off.');

    $('refreshThisTab').click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh', incognito: false, tabId: 7 },
      expect.any(Function)
    );

    onMessage({ action: 'refreshStarted', singleTab: true, tabs: [{ id: 7, title: 'Lofi', url: 'https://www.youtube.com/watch?v=abc' }] });
    expect(state()).toBe('tab-running');
    expect($('tabSiteBig').textContent).toBe('youtube.com');
    expect($('trackText').textContent).toBe('Reloading this tab…');

    onMessage({ action: 'refreshComplete', details: { totalTabs: 1, processedTabs: 1, successfulTabs: 1, singleTab: true, staleBytes: 0 } });
    await settle(3000);
    expect(state()).toBe('tab-done');
    expect($('doneTitle').textContent).toBe('Reloaded youtube.com');
    expect(getContext).not.toHaveBeenCalled();
  });

  test('a cancelled single-tab reload names the site it stopped waiting for', async () => {
    const onMessage = executePopupJs();
    await settle();
    $('refreshThisTab').click();
    onMessage({ action: 'refreshStarted', singleTab: true, tabs: [{ id: 7, url: 'https://www.youtube.com/watch?v=abc' }] });

    $('cancelTab').click();
    onMessage({ action: 'refreshComplete', details: { totalTabs: 1, processedTabs: 0, successfulTabs: 0, cancelled: true, singleTab: true } });

    expect(state()).toBe('tab-stopped');
    expect($('stopTitle').textContent).toBe('Stopped waiting for youtube.com.');
  });

  test.each([
    'chrome://extensions/',
    'about:blank',
    'chrome-extension://abc/popup.html'
  ])('this-tab action is disabled with a reason on %s', async url => {
    executePopupJs({ activeTab: { id: 3, title: 'Browser page', url } });
    await settle();

    // Still focusable, so the reason it describes is read out.
    expect($('refreshThisTab').disabled).toBe(false);
    expect($('refreshThisTab').getAttribute('aria-disabled')).toBe('true');
    $('refreshThisTab').click();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'startRefresh' }), expect.anything());
    expect($('thisTabSite').textContent).toBe('');
    expect($('thisTabNote').textContent).toBe('Chrome protects this page, so it cannot be reloaded from here.');
  });

  test('this-tab action stays enabled on the Web Store, which the worker reloads too', async () => {
    executePopupJs({ activeTab: { id: 4, title: 'Store', url: 'https://chromewebstore.google.com/detail/x' } });
    await settle();

    expect($('refreshThisTab').getAttribute('aria-disabled')).toBe('false');
    expect($('thisTabSite').textContent).toBe('chromewebstore.google.com');
  });

  test('promises kept videos under this tab only while page reading is allowed', async () => {
    executePopupJs({ siteAccess: false, requestAccessResult: true });
    await settle();
    expect($('thisTabNote').textContent).toBe('Fetches fresh files.');

    $('openSettings').click();
    $('grantAccess').click();
    await settle();
    expect($('thisTabNote').textContent).toBe('Fetches fresh files. Videos pick up where they left off.');
  });

  test.each([
    [[{ id: 1, windowId: 1 }], '1 tab open in 1 window.'],
    [[{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }], '2 tabs open in 1 window.'],
    [[{ id: 1, windowId: 1 }, { id: 2, windowId: 2 }, { id: 3, windowId: 2 }, { id: 4, windowId: 3, incognito: true }],
      '3 tabs open in 2 windows.']
  ])('the ready screen counts the tabs a run covers', async (openTabs, count) => {
    executePopupJs({ openTabs });
    await settle();

    expect($('readyExplain').querySelector('b').textContent).toBe(count);
    expect($('readyExplain').textContent).toBe(`${count} Reloads the tabs it can and fetches fresh files instead of reusing copies Chrome saved earlier. Your site data stays in place.`);
  });

  test('offline, the refresh buttons wait and say why until the network is back', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      executePopupJs({ openTabs: [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }] });
      await settle();

      const warning = 'You are offline. Reloading now would turn your tabs into error pages, so reloading waits until you are back online.';
      expect($('refreshAll').disabled).toBe(true);
      expect($('refreshThisTab').disabled).toBe(true);
      expect($('readyExplain').textContent).toBe(warning);
      expect($('statusText').textContent).toBe(warning);

      window.dispatchEvent(new Event('online'));
      expect($('refreshAll').disabled).toBe(false);
      expect($('readyExplain').querySelector('b').textContent).toBe('2 tabs open in 1 window.');
    } finally {
      delete navigator.onLine;
    }
  });

  test.each([
    ['Just refresh', 'justRefresh'],
    ['Allow and refresh', 'allowAndRefresh']
  ])('offline, "%s" on the permission question does not start a reload', async (_label, id) => {
    executePopupJs({ siteAccess: false, mediaAccessAsked: false });
    await settle();
    $('refreshAll').click();
    expect(state()).toBe('ask');

    window.dispatchEvent(new Event('offline'));
    $(id).click();
    await settle();
    window.dispatchEvent(new Event('online'));

    expect(chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'startRefresh')).toHaveLength(0);
  });

  test('does not activate stress mode after five settings clicks', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => false);
    executePopupJs();
    await settle();

    for (let index = 0; index < 5; index++) {
      $('openSettings').click();
      $('back').click();
    }

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
