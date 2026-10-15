function t(key, ...substitutions) {
    return chrome.i18n.getMessage(
        key,
        substitutions.length > 0 ? substitutions.map(String) : undefined
    );
}

function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = Number.isFinite(bytes) ? bytes : 0;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    const fractionDigits = unitIndex === 0 ? 0 : 1;
    return `${value.toLocaleString(t('htmlLang'), {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
    })} ${units[unitIndex]}`;
}

// The same schemes isRestrictedTabUrl in background.js skips; a unit test keeps
// the two lists equal, so the popup never offers a reload the worker would skip.
const RESTRICTED_URL_PREFIXES = [
    'about:',
    'chrome:',
    'chrome-extension:',
    'chrome-search:',
    'chrome-untrusted:',
    'devtools:',
    'edge:'
];

function isRestrictedTabUrl(url) {
    if (!url) return false;
    return RESTRICTED_URL_PREFIXES.some(protocol => url.startsWith(protocol));
}

function siteName(tab) {
    try {
        const host = new URL(tab?.url).hostname.replace(/^www\./, '');
        if (host) return host;
    } catch (error) {
        // Not a URL with a host; fall back to the title below.
    }
    return tab?.title || t('tabFallbackTitle');
}

const $ = id => document.getElementById(id);
const body = document.body;
const refreshButton = $('refreshAll');
const allowButton = $('allowAndRefresh');
const justRefreshButton = $('justRefresh');
const cancelButton = $('cancelRefresh');
const cancelTabButton = $('cancelTab');
const thisTabButton = $('refreshThisTab');
const thisTabSite = $('thisTabSite');
const thisTabNote = $('thisTabNote');
const progressBar = $('progressBar');
const progressFill = $('progressFill');
const progressPercent = $('progressPercent');
const trackText = $('trackText');
const ringFill = $('ringFill');
const pillText = $('pillText');
const runPill = $('runPill');
const runCount = $('runCount');
const runTotal = $('runTotal');
const statusText = $('statusText');
const tabDots = $('tabDots');
const footRunning = $('footRunning');
const footDone = $('footDone');
const failedList = $('failedList');
const historyList = $('historyList');
const grantAccess = $('grantAccess');
const resetStats = $('resetStats');
const undoReset = $('undoReset');
const undoResetButton = $('undoResetButton');
const confettiCanvas = $('confetti');

document.documentElement.lang = t('htmlLang');
document.title = t('appName');
document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
});
document.querySelectorAll('[data-i18n-label]').forEach(element => {
    element.setAttribute('aria-label', t(element.dataset.i18nLabel));
});

// Nothing animates while the popup opens: transitions start after two frames.
requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('preload')));

let state = 'ready';
let view = 'home';
let initializing = true;
let accessRequestPending = false;
let activeRefreshOperation = false;
let singleTabRun = false;
let runTabs = [];
let runSite = '';
let lastAnnouncedQuarter = 0;
let siteAccessGranted = false;
let mediaAccessAsked = false;
// A run covers only tabs of the same kind as this popup's window, normal or incognito.
let windowIncognito = false;
let activeTab = null;
let latestHistory = [];
let historyRevealed = false;
let savedStats = null;
let undoTimer = 0;
// Which worker operation this popup is showing. A completed or cancelled run can
// broadcast after a newer refresh started, and acting on it would report the wrong
// run as finished.
let operationGeneration = 0;

// ---- State and views ----

function setState(next) {
    const focused = document.activeElement;
    state = next;
    body.dataset.state = next;
    document.querySelectorAll('.slot > .v').forEach(variant => {
        variant.classList.toggle('on', variant.dataset.states.split(' ').includes(next));
    });
    footRunning.classList.toggle('on', next === 'running');
    footDone.classList.toggle('on', next !== 'running');
    updateRunPill();
    return focused;
}

// A control that just became hidden takes keyboard focus with it; hand it to the
// control that now sits in its place instead of dropping it on the document.
function moveFocusFromHidden(previouslyFocused, target) {
    const variant = previouslyFocused?.closest?.('.slot > .v');
    if (variant && !variant.classList.contains('on')) target.focus({ preventScroll: true });
}

function setView(next) {
    const previous = view;
    view = next;
    const isHome = next === 'home';
    $('homeView').classList.toggle('on', isHome);
    $('subView').classList.toggle('on', !isHome);
    $('homeHead').classList.toggle('on', isHome);
    $('subHead').classList.toggle('on', !isHome);

    if (!isHome) {
        document.querySelectorAll('.panel').forEach(panel => {
            panel.hidden = panel.dataset.panel !== next;
        });
        $('subTitle').textContent = t({
            history: 'historyTitle',
            files: 'statsToggle',
            settings: 'settingsToggle'
        }[next]);
        $('subView').scrollTop = 0;
        if (next === 'history') {
            renderHistory(!historyRevealed);
            historyRevealed = true;
        }
        $('back').focus({ preventScroll: true });
    } else if (previous !== 'home') {
        document.querySelector(`.row[data-open="${previous}"]`)?.focus({ preventScroll: true });
    }
    updateRunPill();
}

function updateRunPill() {
    runPill.classList.toggle('on', activeRefreshOperation && view !== 'home');
}

function updateControls() {
    refreshButton.disabled = initializing || activeRefreshOperation || accessRequestPending;
    thisTabButton.disabled = refreshButton.disabled || !thisTabAvailable();
}

function announce(text) {
    statusText.textContent = text;
}

document.querySelectorAll('.row[data-open]').forEach(row => {
    row.addEventListener('click', () => setView(row.dataset.open));
});
$('back').addEventListener('click', () => setView('home'));

// ---- Numbers ----

// One tween per element, cancelled when a new value arrives.
function tween(element, to, format = String, duration = 260) {
    const from = Number(element.dataset.value || 0);
    element.dataset.value = String(to);
    cancelAnimationFrame(element.tweenFrame);
    if (from === to) {
        element.textContent = format(to);
        return;
    }
    const startedAt = performance.now();
    const frame = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = format(Math.round(from + (to - from) * eased));
        if (progress < 1) element.tweenFrame = requestAnimationFrame(frame);
    };
    frame(startedAt);
}

function setNumber(element, value, format = String) {
    cancelAnimationFrame(element.tweenFrame);
    element.dataset.value = String(value);
    element.textContent = format(value);
}

function setCounts(reloaded, failed, skipped, animate) {
    const write = animate ? tween : setNumber;
    write($('countReloaded'), reloaded);
    write($('countFailed'), failed);
    write($('countSkipped'), skipped);
    $('chipFailed').hidden = failed === 0;
    $('chipSkipped').hidden = skipped === 0;
}

// ---- Progress follower ----
// Progress arrives as one message per finished tab, from 100 ms to several seconds
// apart. The bar draws a position x that a critically damped spring (no overshoot)
// pulls toward a target. While a tab is in flight the target creeps from the real
// fraction toward 90 percent of the next step: creep = 0.9 * step * t / (t + tau),
// where t is the time since the last real message and tau is a moving average of
// step durations. x never moves backward and never passes real + 0.9 step, and
// aria-valuenow carries only the real value.
const SPRING_OMEGA = 14; // rad/s: 95 percent of a catch-up in about 340 ms
const CREEP_CAP = 0.9;
const STEP_AVERAGE_WEIGHT = 0.3;
const RING_LENGTH = 37.7;
const bar = {
    x: 0, v: 0, target: 0, done: 0, total: 1, lastMessageAt: 0, stepAverage: 500,
    inflight: false, onFull: null, single: false, frame: 0, lastFrameAt: 0
};

function barRender() {
    const realPercent = Math.round((bar.done / bar.total) * 100);
    // Numbers follow the bar but never claim a tab that has not finished.
    const percent = Math.min(Math.floor(bar.x * 100 + 1e-6), realPercent);
    progressFill.style.transform = `translateX(${((bar.x - 1) * 100).toFixed(3)}%)`;
    ringFill.style.strokeDashoffset = String(RING_LENGTH * (1 - bar.x));
    progressPercent.textContent = `${percent}%`;
    pillText.textContent = `${percent}%`;
    if (!bar.single) runCount.textContent = String(Math.min(Math.floor(bar.x * bar.total + 1e-6), bar.done));
}

function barTargetAt(now) {
    let target = bar.done / bar.total;
    if (bar.inflight && bar.done < bar.total) {
        const elapsed = now - bar.lastMessageAt;
        target += (CREEP_CAP / bar.total) * elapsed / (elapsed + bar.stepAverage);
    }
    return Math.max(bar.target, target);
}

function barFrame(now) {
    bar.frame = 0;
    const dt = Math.min(0.25, Math.max(0, (now - bar.lastFrameAt) / 1000));
    bar.lastFrameAt = now;
    bar.target = barTargetAt(now);
    // Closed-form critically damped step: exact for any dt, so 60, 90 and 120 Hz match.
    const offset = bar.x - bar.target;
    const decay = Math.exp(-SPRING_OMEGA * dt);
    const k = bar.v + SPRING_OMEGA * offset;
    let x = bar.target + (offset + k * dt) * decay;
    let v = (bar.v - SPRING_OMEGA * k * dt) * decay;
    if (x > bar.target) {
        x = bar.target;
        v = 0;
    }
    if (x < bar.x) {
        x = bar.x;
        v = Math.max(0, v);
    }
    bar.x = x;
    bar.v = v;

    if (bar.onFull && bar.x > 0.997) {
        bar.x = 1;
        bar.v = 0;
        barRender();
        const onFull = bar.onFull;
        bar.onFull = null;
        onFull();
        return;
    }

    const idle = !bar.inflight && !bar.onFull && bar.target - bar.x < 5e-4;
    if (idle) {
        bar.x = bar.target;
        bar.v = 0;
    }
    barRender();
    if (!idle) bar.frame = requestAnimationFrame(barFrame);
}

function barKick() {
    if (bar.frame || document.visibilityState !== 'visible') return;
    bar.lastFrameAt = performance.now();
    bar.frame = requestAnimationFrame(barFrame);
}

function barHalt() {
    cancelAnimationFrame(bar.frame);
    bar.frame = 0;
    bar.inflight = false;
    bar.onFull = null;
}

function barStart(total, stepAverage, single, done = 0) {
    barHalt();
    bar.total = Math.max(1, total);
    bar.done = Math.min(done, bar.total);
    bar.x = bar.target = bar.done / bar.total;
    bar.v = 0;
    bar.single = single;
    bar.stepAverage = stepAverage;
    bar.lastMessageAt = performance.now();
    bar.inflight = true;
    progressBar.setAttribute('aria-valuenow', String(Math.round(bar.x * 100)));
    barRender();
    barKick();
}

function barReal(done) {
    const now = performance.now();
    const finished = done - bar.done;
    if (finished <= 0) return;
    bar.stepAverage += STEP_AVERAGE_WEIGHT * ((now - bar.lastMessageAt) / finished - bar.stepAverage);
    bar.stepAverage = Math.min(5000, Math.max(80, bar.stepAverage));
    bar.done = Math.min(done, bar.total);
    bar.lastMessageAt = now;
    progressBar.setAttribute('aria-valuenow', String(Math.round((bar.done / bar.total) * 100)));
    barKick();
}

// Fill to 100 percent, then hand over to the result. A hidden popup skips the
// animation: nobody would see it, and the result must not wait for a frame.
function barFinish(onFull) {
    bar.done = bar.total;
    bar.inflight = false;
    progressBar.setAttribute('aria-valuenow', '100');
    if (document.visibilityState !== 'visible') {
        barHalt();
        bar.x = 1;
        barRender();
        onFull();
        return;
    }
    bar.onFull = onFull;
    barKick();
}

function barSet(done, total) {
    barHalt();
    bar.total = Math.max(1, total);
    bar.done = Math.min(done, bar.total);
    bar.x = bar.target = bar.done / bar.total;
    bar.v = 0;
    progressBar.setAttribute('aria-valuenow', String(Math.round(bar.x * 100)));
    barRender();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        cancelAnimationFrame(bar.frame);
        bar.frame = 0;
    } else if (activeRefreshOperation || bar.onFull) {
        barKick();
    }
});

// ---- Tab dots ----

const dotsByTabId = new Map();

function buildDots(tabs, statuses, animate) {
    tabDots.textContent = '';
    dotsByTabId.clear();
    tabDots.classList.toggle('static', !animate);
    tabDots.classList.remove('settled');
    // 23 per row at 10 px, 30 at 8 px, 41 at 6 px: 200 tabs stay within five rows.
    const size = tabs.length <= 46 ? 10 : tabs.length <= 120 ? 8 : 6;
    const gap = tabs.length <= 46 ? 4 : tabs.length <= 120 ? 3 : 2;
    tabDots.style.setProperty('--dot', `${size}px`);
    tabDots.style.setProperty('--gap', `${gap}px`);

    const fragment = document.createDocumentFragment();
    tabs.forEach((tab, index) => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.setProperty('--i', String(index));
        const status = statuses[tab.id];
        if (status && status !== 'pending') dot.dataset.status = status;
        dotsByTabId.set(String(tab.id), dot);
        fragment.appendChild(dot);
    });
    tabDots.appendChild(fragment);
}

function updateTabStatus(tabId, status) {
    const dot = dotsByTabId.get(String(tabId));
    if (dot) dot.dataset.status = status;
}

// ---- Running a reload ----

function thisTabAvailable() {
    return Boolean(activeTab) && !isRestrictedTabUrl(activeTab.url);
}

function renderThisTab() {
    const available = thisTabAvailable();
    thisTabSite.textContent = available ? siteName(activeTab) : '';
    thisTabButton.title = available ? siteName(activeTab) : '';
    thisTabNote.textContent = t(available ? 'refreshThisTabHint' : 'thisTabUnavailable');
    updateControls();
}

refreshButton.addEventListener('click', () => {
    if (activeRefreshOperation || refreshButton.disabled) return;

    // The first refresh explains the optional permission before Chrome asks for it.
    if (!siteAccessGranted && !mediaAccessAsked) {
        const focused = setState('ask');
        moveFocusFromHidden(focused, allowButton);
        return;
    }

    requestRefresh();
});

allowButton.addEventListener('click', () => {
    rememberAccessAsked();
    requestSiteAccess().then(() => requestRefresh());
});

justRefreshButton.addEventListener('click', () => {
    rememberAccessAsked();
    requestRefresh();
});

thisTabButton.addEventListener('click', () => {
    if (activeRefreshOperation || thisTabButton.disabled || !thisTabAvailable()) return;
    requestRefresh(activeTab.id);
});

grantAccess.addEventListener('click', () => {
    requestSiteAccess();
});

cancelButton.addEventListener('click', () => cancelRun(cancelButton));
cancelTabButton.addEventListener('click', () => cancelRun(cancelTabButton));

function rememberAccessAsked() {
    mediaAccessAsked = true;
    chrome.storage.local.set({ mediaAccessAsked: true });
}

function requestRefresh(tabId) {
    if (activeRefreshOperation) return;
    activeRefreshOperation = true;
    updateControls();
    announce(t('statusStarting'));

    const message = { action: 'startRefresh', incognito: windowIncognito };
    if (tabId !== undefined) message.tabId = tabId;
    chrome.runtime.sendMessage(message, (response) => {
        const errorMessage = chrome.runtime.lastError?.message || response?.message;
        if (!errorMessage && response?.success) return;

        // Another popup or window already started a run: show that one.
        if (errorMessage === t('errorOperationInProgress')) {
            activeRefreshOperation = false;
            restoreOperationStatus().then(updateControls);
            return;
        }
        showStartFailure(errorMessage || t('errorUnknown'));
    });
}

function cancelRun(button) {
    if (!activeRefreshOperation) return;

    button.disabled = true;
    bar.inflight = false;
    trackText.textContent = t('statusCancelling');
    announce(t('statusCancelling'));
    chrome.runtime.sendMessage({ action: 'cancelOperation' }, (response) => {
        if (!activeRefreshOperation) return;
        if (chrome.runtime.lastError || !response?.success) {
            button.disabled = false;
            bar.inflight = true;
            barKick();
            trackText.textContent = t('statusCancelFailed');
            announce(t('statusCancelFailed'));
        }
    });
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'refreshStarted') {
        if (isObsoleteOperation(message)) return;
        operationGeneration = Number.isFinite(message.generation)
            ? message.generation
            : operationGeneration;
        startRunUI(message.tabs || [], {}, message.singleTab === true, { live: true });
    } else if (message.action === 'refreshProgress') {
        if (isObsoleteOperation(message)) return;
        updateProgressUI(message);
    } else if (message.action === 'refreshComplete') {
        if (isObsoleteOperation(message)) return;
        handleRefreshComplete(message);
    } else if (message.action === 'tabSucceeded') {
        updateTabStatus(message.tabId, 'success');
    } else if (message.action === 'tabFailed') {
        updateTabStatus(message.tabId, 'error');
    } else if (message.action === 'tabSkipped') {
        updateTabStatus(message.tabId, 'skipped');
    }
});

// An older worker sends no generation at all, so an absent one is always accepted:
// filtering it out would leave the popup stuck waiting for a message never coming.
function isObsoleteOperation(message) {
    return Number.isFinite(message.generation) && message.generation < operationGeneration;
}

function startRunUI(tabs, statuses, single, { live, done = 0, counts } = {}) {
    activeRefreshOperation = true;
    singleTabRun = single;
    runTabs = tabs;
    lastAnnouncedQuarter = Math.floor((done / Math.max(1, tabs.length)) * 4);
    cancelButton.disabled = false;
    cancelTabButton.disabled = false;
    footDone.textContent = '';
    stopConfetti();

    if (single) {
        body.dataset.single = '';
        const tab = tabs[0] || activeTab;
        runSite = siteName(tab);
        $('tabSiteBig').textContent = runSite;
        $('tabSiteBig').title = runSite;
        $('tabPageTitle').textContent = tab?.title || runSite;
        trackText.textContent = t('statusThisTab');
    } else {
        delete body.dataset.single;
        runTotal.textContent = t('runCountOf', tabs.length);
        trackText.textContent = t('statusRefreshingTabs');
        setCounts(counts?.reloaded || 0, counts?.failed || 0, counts?.skipped || 0, false);
        buildDots(tabs, statuses, live);
    }

    barStart(tabs.length, single ? 1500 : 500, single, done);
    const focused = setState(single ? 'tab-running' : 'running');
    moveFocusFromHidden(focused, single ? cancelTabButton : cancelButton);
    updateControls();
    if (live) announce(single ? t('statusThisTab') : t('statusProcessedInitial', tabs.length));
}

function updateProgressUI(data) {
    if (!activeRefreshOperation) return;

    const processed = Number(data.current) || 0;
    const total = Number(data.total) || runTabs.length;
    if (!singleTabRun) {
        setCounts(Number(data.successful) || 0, Number(data.failed) || 0, Number(data.skipped) || 0, true);
    }
    barReal(processed);

    // Announce at quarters only; one announcement per tab would flood a screen reader.
    const quarter = Math.floor((Number(data.percent) || 0) / 25);
    if (!singleTabRun && quarter > lastAnnouncedQuarter && quarter < 4) {
        lastAnnouncedQuarter = quarter;
        announce(t('statusMilestone', processed, total));
    }
}

function handleRefreshComplete(data) {
    const details = data.details || {};
    const failedTabs = Array.isArray(data.failedTabs) ? data.failedTabs : [];
    const result = {
        total: Number(details.totalTabs) || 0,
        processed: Number(details.processedTabs) || 0,
        reloaded: Number(details.successfulTabs) || 0,
        failed: Number(details.failedCount) || 0,
        skipped: Number(details.skippedCount) || 0,
        cancelled: details.cancelled === true,
        single: details.singleTab === true || singleTabRun,
        staleBytes: Number.isFinite(details.staleBytes) ? details.staleBytes : 0,
        failedTabs
    };
    result.processed = result.processed || result.reloaded + result.failed + result.skipped;
    const wasRunning = activeRefreshOperation;
    activeRefreshOperation = false;
    updateControls();

    // The worker could not start (no tabs, or the query failed): it reports that as
    // a run of zero tabs with one failure entry carrying the reason.
    if (result.total === 0) {
        showStartFailure(failedTabs[0]?.error || t('errorUnknown'));
        refreshStoredViews();
        return;
    }

    const show = () => {
        showResult(result, { live: wasRunning });
        refreshStoredViews();
    };
    if (result.cancelled || !wasRunning) {
        barHalt();
        barSet(result.processed, result.total);
        show();
    } else {
        barFinish(show);
    }
}

function showResult(result, { live }) {
    let title;
    let next;
    tabDots.classList.add('settled');
    if (!result.single) setCounts(result.reloaded, result.failed, result.skipped, live);

    if (result.cancelled) {
        title = result.single
            ? t('statusThisTabStopped', runSite)
            : t('statusCancelled', result.processed, result.total);
        $('stopTitle').textContent = title;
        $('stopSub').textContent = t(result.single ? 'statusThisTabStoppedSub' : 'stoppedSub');
        next = result.single ? 'tab-stopped' : 'stopped';
    } else if (result.failed > 0 || result.failedTabs.length > 0) {
        title = t(result.failed === 1 ? 'errorFailedSummaryOne' : 'errorFailedSummaryOther', result.failed);
        renderFailure(title, t('statusCompleteMixed', result.processed, result.total, result.reloaded, result.failed, result.skipped), result);
        next = 'failed';
    } else if (result.single && result.reloaded === 0) {
        // The tab closed or turned into a browser page before its turn.
        title = t('statusThisTabSkipped', runSite);
        renderFailure(title, '', null);
        next = 'failed';
    } else if (result.single) {
        title = t('statusThisTabDone', runSite);
        $('doneTitle').textContent = title;
        $('doneSub').textContent = t('doneSubFresh');
        renderBytes($('tabBytes'), result.staleBytes, live);
        next = 'tab-done';
    } else {
        title = result.skipped > 0
            ? t('statusCompleteSkipped', result.reloaded, result.skipped)
            : result.reloaded === 1 ? t('statusCompleteAllOne') : t('statusCompleteAll', result.reloaded);
        $('doneTitle').textContent = title;
        $('doneSub').textContent = t(result.skipped > 0 ? 'doneSubSkipped' : 'doneSubFresh');
        renderBytes(footDone, result.staleBytes, live);
        next = 'done';
    }

    const focused = setState(next);
    moveFocusFromHidden(focused, refreshButton);
    announce(title);

    // Confetti marks a clean run over every tab that the user is watching right now.
    if (live && next === 'done' && result.reloaded >= 1) {
        requestAnimationFrame(burstConfetti);
    }
}

function renderFailure(title, sub, result) {
    $('failTitle').textContent = title;
    $('failSub').textContent = sub;
    const chips = document.querySelector('.detail-failed .chips');
    chips.hidden = !result;
    failedList.textContent = '';
    failedList.hidden = !result;
    if (!result) return;

    setNumber($('failedReloaded'), result.reloaded);
    setNumber($('failedFailed'), result.failed);
    setNumber($('failedSkipped'), result.skipped);
    const entries = result.failedTabs.length > 0
        ? result.failedTabs
        : [{ title: t('errorNoTabDetails'), error: '' }];
    entries.forEach(tab => {
        const item = document.createElement('li');
        const marker = document.createElement('i');
        const name = document.createElement('b');
        name.textContent = tab.title || t('tabFallbackTitle');
        name.title = name.textContent;
        const reason = document.createElement('span');
        reason.textContent = tab.error || '';
        item.append(marker, name, reason);
        failedList.appendChild(item);
    });
}

// The byte figure sits inside a translated sentence; split the sentence around it
// so the number can be bold and count up once.
function renderBytes(element, bytes, animate) {
    element.textContent = '';
    if (!(bytes > 0)) return;
    const marker = '\u0000';
    const [before, after = ''] = t('statsRunLine', marker).split(marker);
    const figure = document.createElement('b');
    figure.className = 'num';
    element.append(before, figure, after);
    if (animate) {
        figure.dataset.value = '0';
        tween(figure, bytes, formatBytes, 700);
    } else {
        setNumber(figure, bytes, formatBytes);
    }
}

function showStartFailure(message) {
    activeRefreshOperation = false;
    barHalt();
    renderFailure(t('errorStartTitle'), message, null);
    const focused = setState('failed');
    moveFocusFromHidden(focused, refreshButton);
    announce(t('statusStartFailed', message));
    updateControls();
}

function restoreOperationStatus() {
    return new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getOperationStatus' }, (snapshot) => {
        if (chrome.runtime.lastError || !snapshot) {
            resolve();
            return;
        }

        if (snapshot.active) {
            if (Number.isFinite(snapshot.generation)) operationGeneration = snapshot.generation;
            startRunUI(snapshot.currentTabs || [], snapshot.tabStatuses || {}, snapshot.singleTab === true, {
                live: false,
                done: Number(snapshot.processedTabs) || 0,
                counts: {
                    reloaded: Number(snapshot.refreshedTabs) || 0,
                    failed: Number(snapshot.failedTabs) || 0,
                    skipped: Number(snapshot.skippedTabs) || 0
                }
            });
        } else if (snapshot.interrupted) {
            const total = Number(snapshot.totalTabs) || 0;
            buildDots([], {}, false);
            setCounts(Number(snapshot.refreshedTabs) || 0, Number(snapshot.failedTabs) || 0, Number(snapshot.skippedTabs) || 0, false);
            barSet(Number(snapshot.processedTabs) || 0, total);
            footDone.textContent = '';
            $('stopTitle').textContent = t('statusInterrupted');
            $('stopSub').textContent = t('errorInterruptedDetail');
            setState('stopped');
            announce(t('statusInterrupted'));
        }
        resolve();
    }));
}

// ---- Page access ----

async function hasSiteAccess() {
    try {
        const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        return !chrome.runtime.lastError && granted === true;
    } catch (error) {
        return false;
    }
}

function renderSiteAccess(granted) {
    const pill = $('accessPill');
    pill.textContent = t(granted ? 'pillOn' : 'pillOff');
    pill.classList.toggle('on', granted);
    grantAccess.hidden = granted;
    $('statsAccessHint').hidden = granted;
    $('metaSettings').textContent = t(granted ? 'settingsAccessOn' : 'settingsAccessOff');
}

function requestSiteAccess() {
    accessRequestPending = true;
    updateControls();
    let request;
    try {
        request = chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (error) {
        request = false;
    }
    return Promise.resolve(request).then(granted => {
        siteAccessGranted = !chrome.runtime.lastError && granted === true;
        renderSiteAccess(siteAccessGranted);
        return siteAccessGranted;
    }).catch(() => {
        siteAccessGranted = false;
        renderSiteAccess(false);
        return false;
    }).finally(() => {
        accessRequestPending = false;
        updateControls();
    });
}

function initializeSiteAccess() {
    const storedAccess = new Promise((resolve) => {
        chrome.storage.local.get(['mediaAccessAsked'], (result) => {
            mediaAccessAsked = result.mediaAccessAsked === true;
            resolve();
        });
    });
    const currentAccess = hasSiteAccess().then(granted => {
        siteAccessGranted = granted;
        renderSiteAccess(granted);
    });
    return Promise.allSettled([storedAccess, currentAccess]);
}

// ---- History ----

function relativeTime(timestamp) {
    const formatter = new Intl.RelativeTimeFormat(t('htmlLang'), { numeric: 'auto' });
    const seconds = (new Date(timestamp).getTime() - Date.now()) / 1000;
    const distance = Math.abs(seconds);
    if (distance < 60) return formatter.format(0, 'second');
    if (distance < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
    if (distance < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
    return formatter.format(Math.round(seconds / 86400), 'day');
}

function validDate(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

function refreshStoredViews() {
    initializeHistory();
    initializeStats();
}

function initializeHistory() {
    chrome.storage.local.get(['refreshHistory'], (result) => {
        latestHistory = Array.isArray(result.refreshHistory) ? result.refreshHistory : [];
        const latest = latestHistory[0];
        const date = latest && validDate(latest.timestamp);
        $('metaHistory').textContent = latest
            ? (date ? relativeTime(date) : t('historyUnknownDate'))
            : t('historyEmpty');
        renderReadySub();
        if (view === 'history') renderHistory(false);
    });
}

function renderReadySub() {
    const latest = latestHistory[0];
    const date = latest && validDate(latest.timestamp);
    $('readySub').textContent = date
        ? t('heroLastRun', relativeTime(date), Number(latest.successfulTabs) || 0, Number(latest.totalTabs) || 0)
        : t(windowIncognito ? 'heroReadySubIncognito' : 'heroReadySub');
}

function renderHistory(animate) {
    historyList.textContent = '';
    historyList.classList.toggle('reveal', animate);

    if (latestHistory.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = t('historyEmpty');
        historyList.appendChild(empty);
        return;
    }

    latestHistory.forEach((item, index) => {
        const row = document.createElement('li');
        row.style.setProperty('--i', String(index));
        const reloaded = Number(item.successfulTabs) || 0;
        const total = Number(item.totalTabs) || 0;
        const failed = Number(item.failedCount)
            || (Array.isArray(item.failedTabs) ? item.failedTabs.length : 0);
        const skipped = Number(item.skippedCount) || 0;

        const marker = document.createElement('i');
        if (item.cancelled || item.interrupted) marker.className = 'stop';
        else if (failed > 0) marker.className = 'bad';

        const summary = document.createElement('b');
        summary.textContent = item.interrupted
            ? t('historyEntryInterrupted', reloaded, total)
            : item.cancelled
            ? t('historyEntryCancelled', reloaded, total)
            : t('historyEntryReloaded', reloaded, total);

        const when = document.createElement('span');
        when.className = 'when';
        const date = validDate(item.timestamp);
        when.textContent = date ? relativeTime(date) : t('historyUnknownDate');
        if (date) when.title = date.toLocaleString(t('htmlLang'));

        const detail = document.createElement('span');
        detail.className = 'sub2';
        detail.textContent = item.interrupted
            ? t('historyEntryInterruptedDetail')
            : item.cancelled
            ? t('historyEntryStoppedDetail')
            : item.singleTab
            ? t('thisTabLabel')
            : t('historyEntryDetail', failed, skipped);

        row.append(marker, summary, when, detail);
        historyList.appendChild(row);
    });
}

// ---- Statistics ----

function readCacheStats(raw) {
    const cacheStats = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const days = cacheStats.days && typeof cacheStats.days === 'object' && !Array.isArray(cacheStats.days)
        ? cacheStats.days
        : {};
    return {
        days,
        lastRun: Number.isFinite(cacheStats.lastRun) ? cacheStats.lastRun : 0,
        total: Number.isFinite(cacheStats.total) ? cacheStats.total : 0
    };
}

function renderStat(element, bytes) {
    element.textContent = '';
    if (bytes > 0) {
        const prefix = document.createElement('small');
        prefix.textContent = t('statsApproxPrefix');
        element.append(prefix);
    }
    element.append(formatBytes(bytes));
}

function initializeStats() {
    renderSiteAccess(siteAccessGranted);
    chrome.storage.local.get(['cacheStats'], (result) => {
        const { days, lastRun, total } = readCacheStats(result.cacheStats);
        const todayValue = days[dayKey()];
        const today = Number.isFinite(todayValue) ? todayValue : 0;
        let week = 0;
        let month = 0;

        for (let offset = 0; offset < 30; offset++) {
            const date = new Date();
            date.setDate(date.getDate() - offset);
            const value = days[dayKey(date)];
            if (!Number.isFinite(value)) continue;
            month += value;
            if (offset < 7) week += value;
        }

        $('statsTotal').textContent = formatBytes(total);
        renderStat($('statsToday'), today);
        renderStat($('statsLastRun'), lastRun);
        renderStat($('statsWeek'), week);
        renderStat($('statsMonth'), month);
        $('metaFiles').textContent = total > 0 ? `≈ ${formatBytes(total)}` : '';
    });
}

function endUndoWindow() {
    clearTimeout(undoTimer);
    savedStats = null;
    undoReset.hidden = true;
    resetStats.hidden = false;
}

resetStats.addEventListener('click', () => {
    chrome.storage.local.get(['cacheStats'], (result) => {
        savedStats = result.cacheStats ?? null;
    });
    chrome.storage.local.remove(['cacheStats'], initializeStats);
    resetStats.hidden = true;
    undoReset.hidden = false;
    undoResetButton.focus({ preventScroll: true });
    clearTimeout(undoTimer);
    undoTimer = setTimeout(endUndoWindow, 6000);
});

undoResetButton.addEventListener('click', () => {
    const previous = savedStats ? readCacheStats(savedStats) : null;
    endUndoWindow();
    resetStats.focus({ preventScroll: true });
    if (!previous) return;

    // A run that finished after the reset added its bytes to a fresh record; keep them.
    chrome.storage.local.get(['cacheStats'], (result) => {
        const current = readCacheStats(result.cacheStats);
        const days = { ...previous.days };
        Object.entries(current.days).forEach(([key, value]) => {
            if (Number.isFinite(value)) days[key] = (Number.isFinite(days[key]) ? days[key] : 0) + value;
        });
        chrome.storage.local.set({
            cacheStats: {
                lastRun: current.lastRun || previous.lastRun,
                total: previous.total + current.total,
                days
            }
        }, initializeStats);
    });
});

// ---- Confetti ----
// One burst from the success badge: canvas, time-based, 44 pieces, 1.5 s. It stops
// itself at the end, when the popup hides, and when a new burst or run starts.

let confettiStop = null;

function stopConfetti() {
    if (confettiStop) confettiStop();
}

function burstConfetti() {
    if (document.visibilityState !== 'visible') return;
    stopConfetti();
    const context = confettiCanvas.getContext?.('2d');
    if (!context) return;

    const frameBox = confettiCanvas.parentElement.getBoundingClientRect();
    const badge = document.querySelector('.v.on .badge.ok');
    const badgeBox = badge ? badge.getBoundingClientRect() : frameBox;
    const originX = badgeBox.left - frameBox.left + badgeBox.width / 2;
    const originY = badgeBox.top - frameBox.top + badgeBox.height / 2;
    const width = frameBox.width;
    const height = frameBox.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    confettiCanvas.hidden = false;
    confettiCanvas.width = width * ratio;
    confettiCanvas.height = height * ratio;

    const styles = getComputedStyle(document.documentElement);
    const colors = ['--confetti-1', '--confetti-2', '--confetti-3', '--confetti-4']
        .map(name => styles.getPropertyValue(name).trim());
    const COUNT = 44;
    const LIFE = 1500;
    const FADE = 380;
    const pieces = Array.from({ length: COUNT }, (_, index) => {
        const angle = (-90 + (Math.random() * 2 - 1) * 62) * Math.PI / 180;
        const speed = 4.5 + Math.random() * 5.5;
        return {
            x: originX,
            y: originY,
            vx: Math.cos(angle) * speed + 1.2,
            vy: Math.sin(angle) * speed,
            rotation: Math.random() * 6.28,
            spin: (Math.random() - 0.5) * 0.35,
            w: 4 + Math.random() * 4,
            h: 7 + Math.random() * 5,
            flip: Math.random() * 6.28,
            color: colors[index % colors.length],
            round: index % 5 === 0
        };
    });

    let startedAt = 0;
    let previousAt = 0;
    let frame = 0;
    const stop = () => {
        cancelAnimationFrame(frame);
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiCanvas.hidden = true;
        confettiStop = null;
        document.removeEventListener('visibilitychange', stop);
        window.removeEventListener('pagehide', stop);
    };
    const draw = now => {
        if (!startedAt) startedAt = previousAt = now;
        const elapsed = now - startedAt;
        const step = Math.min(2, (now - previousAt) / 16.667);
        previousAt = now;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        context.globalAlpha = elapsed > LIFE - FADE ? Math.max(0, (LIFE - elapsed) / FADE) : 1;
        const drag = Math.pow(0.975, step);
        pieces.forEach(piece => {
            piece.vx *= drag;
            piece.vy = piece.vy * drag + 0.24 * step;
            piece.x += piece.vx * step;
            piece.y += piece.vy * step;
            piece.rotation += piece.spin * step;
            piece.flip += 0.2 * step;
            context.save();
            context.translate(piece.x, piece.y);
            context.rotate(piece.rotation);
            context.scale(1, Math.cos(piece.flip));
            context.fillStyle = piece.color;
            if (piece.round) {
                context.beginPath();
                context.arc(0, 0, piece.w * 0.6, 0, 6.283);
                context.fill();
            } else {
                context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
            }
            context.restore();
        });
        if (elapsed < LIFE) frame = requestAnimationFrame(draw);
        else stop();
    };
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('pagehide', stop);
    frame = requestAnimationFrame(draw);
    confettiStop = stop;
}

// ---- Start ----
// Runs last: a synchronous answer from any of these must find every function and
// constant above already defined.

const siteAccessInitialization = initializeSiteAccess();
const windowInitialization = chrome.windows.getCurrent().then(currentWindow => {
    windowIncognito = currentWindow.incognito === true;
    renderReadySub();
});
const activeTabInitialization = Promise.resolve()
    .then(() => chrome.tabs.query({ active: true, currentWindow: true }))
    .then(tabs => {
        const tab = Array.isArray(tabs) ? tabs[0] : null;
        activeTab = tab && Number.isInteger(tab.id) ? tab : null;
    })
    .catch(() => {
        activeTab = null;
    })
    .finally(renderThisTab);
initializeHistory();
initializeStats();
Promise.allSettled([
    siteAccessInitialization,
    windowInitialization,
    activeTabInitialization,
    restoreOperationStatus()
]).then(() => {
    initializing = false;
    updateControls();
});
