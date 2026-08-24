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

const TAB_STATUS_KEYS = {
    pending: 'tabStatusPending',
    success: 'tabStatusSuccess',
    error: 'tabStatusError',
    skipped: 'tabStatusSkipped'
};

const refreshButton = document.getElementById('refreshAll');
const cancelButton = document.getElementById('cancelRefresh');
const loadingContainer = document.getElementById('loadingContainer');
const progressBar = document.getElementById('progressFill');
const statusText = document.getElementById('statusText');
const statsRunLine = document.getElementById('statsRunLine');
const tabsContainer = document.getElementById('tabsContainer');
const errorContainer = document.getElementById('errorContainer');
const errorSummary = document.getElementById('errorSummary');
const errorDetails = document.getElementById('errorDetails');
const historyContainer = document.getElementById('historyContainer');
const historyHeader = document.getElementById('historyHeader');
const historyContent = document.getElementById('historyContent');
const statsContainer = document.getElementById('statsContainer');
const statsHeader = document.getElementById('statsHeader');
const statsContent = document.getElementById('statsContent');
const statsToday = document.getElementById('statsToday');
const statsLastRun = document.getElementById('statsLastRun');
const statsWeek = document.getElementById('statsWeek');
const statsMonth = document.getElementById('statsMonth');
const statsTotal = document.getElementById('statsTotal');
const statsAccessHint = document.getElementById('statsAccessHint');
const grantAccess = document.getElementById('grantAccess');
const grantAccessExplain = document.getElementById('grantAccessExplain');
const resetStats = document.getElementById('resetStats');
const confettiElement = document.getElementById('confetti');
const settingsHeader = document.getElementById('settingsHeader');
const settingsContent = document.getElementById('settingsContent');

document.documentElement.lang = t('htmlLang');
document.title = t('appName');

[
    ['h2', 'appName'],
    ['.refresh-explanation', 'refreshExplanation'],
    ['#refreshAll', 'actionRefreshAll'],
    ['#cancelRefresh', 'actionCancel'],
    ['#statusText', 'statusRefreshingTabs'],
    ['#historyHeader', 'historyToggle'],
    ['#statsHeader', 'statsToggle'],
    ['#statsAccessHint', 'statsAccessHint'],
    ['#grantAccess', 'permissionGrantAction'],
    ['#grantAccessExplain', 'permissionGrantExplain'],
    ['#resetStats', 'statsResetAction'],
    ['#statsNote', 'statsNote'],
    ['#settingsHeader', 'settingsToggle'],
    ['#settingsContent > .privacy-info:last-child', 'privacyNotice']
].forEach(([selector, key]) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = t(key);
});

document.getElementById('progressBar')?.setAttribute('aria-label', t('progressLabel'));

let activeRefreshOperation = false;
let tabsToRefresh = [];
let processedTabs = 0;
let refreshedTabs = 0;
let failedTabs = [];
let skippedTabs = 0;
let siteAccessGranted = false;
let mediaAccessAsked = false;

initializeSiteAccess();
initializeHistory();
initializeStats();
restoreOperationStatus();

refreshButton.addEventListener('click', () => {
    if (activeRefreshOperation) return;

    if (!siteAccessGranted && !mediaAccessAsked) {
        mediaAccessAsked = true;
        chrome.storage.local.set({ mediaAccessAsked: true });
        requestSiteAccess().then(requestRefresh);
        return;
    }

    requestRefresh();
});

grantAccess.addEventListener('click', () => {
    requestSiteAccess();
});

cancelButton.addEventListener('click', () => {
    if (!activeRefreshOperation) return;

    cancelButton.disabled = true;
    statusText.textContent = t('statusCancelling');
    chrome.runtime.sendMessage({ action: 'cancelOperation' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
            cancelButton.disabled = false;
            statusText.textContent = t('statusCancelFailed');
        }
    });
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'refreshStarted') {
        initializeRefreshUI(message.tabs || []);
    } else if (message.action === 'refreshProgress') {
        updateProgressUI(message);
    } else if (message.action === 'refreshComplete') {
        handleRefreshComplete(message);
    } else if (message.action === 'tabSucceeded') {
        updateTabStatus(message.tabId, 'success');
    } else if (message.action === 'tabFailed') {
        updateTabStatus(message.tabId, 'error');
    } else if (message.action === 'tabSkipped') {
        updateTabStatus(message.tabId, 'skipped');
    }
});

function requestRefresh() {
    activeRefreshOperation = true;
    toggleOperationControls(true);
    loadingContainer.style.display = 'block';
    errorContainer.style.display = 'none';
    statusText.textContent = t('statusStarting');

    chrome.runtime.sendMessage({ action: 'startRefresh' }, (response) => {
        const errorMessage = chrome.runtime.lastError?.message || response?.message;
        if (errorMessage || !response?.success) {
            activeRefreshOperation = false;
            toggleOperationControls(false);
            statusText.textContent = t('statusStartFailed', errorMessage || t('errorUnknown'));
            showOperationError(t('errorStartTitle'), errorMessage || t('errorUnknown'));
        }
    });
}

async function hasSiteAccess() {
    try {
        const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        return !chrome.runtime.lastError && granted === true;
    } catch (error) {
        return false;
    }
}

function renderSiteAccess(granted) {
    const display = granted ? 'none' : 'block';
    grantAccess.style.display = display;
    grantAccessExplain.style.display = display;
    statsAccessHint.style.display = display;
}

function requestSiteAccess() {
    let request;
    try {
        request = chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (error) {
        siteAccessGranted = false;
        renderSiteAccess(false);
        return Promise.resolve(false);
    }

    return Promise.resolve(request).then(granted => {
        siteAccessGranted = !chrome.runtime.lastError && granted === true;
        renderSiteAccess(siteAccessGranted);
        return siteAccessGranted;
    }).catch(() => {
        siteAccessGranted = false;
        renderSiteAccess(false);
        return false;
    });
}

function initializeSiteAccess() {
    chrome.storage.local.get(['mediaAccessAsked'], (result) => {
        mediaAccessAsked = result.mediaAccessAsked === true;
    });
    hasSiteAccess().then(granted => {
        siteAccessGranted = granted;
        renderSiteAccess(granted);
    });
}

function initializeRefreshUI(tabs, statuses = {}) {
    activeRefreshOperation = true;
    tabsToRefresh = tabs;
    processedTabs = 0;
    refreshedTabs = 0;
    failedTabs = [];
    skippedTabs = 0;

    toggleOperationControls(true);
    loadingContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.parentElement?.setAttribute('aria-valuenow', '0');
    statusText.textContent = t('statusProcessedInitial', tabs.length);
    statsRunLine.style.display = 'none';
    statsRunLine.textContent = '';
    errorContainer.style.display = 'none';

    createTabIndicators(tabs);
    applyTabStatuses(statuses);
}

function updateProgressUI(data) {
    if (!activeRefreshOperation) return;

    processedTabs = Number(data.current) || 0;
    refreshedTabs = Number(data.successful) || 0;
    skippedTabs = Number(data.skipped) || 0;
    const failedCount = Number(data.failed) || 0;
    const percent = Number(data.percent) || 0;

    progressBar.style.width = `${percent}%`;
    progressBar.parentElement?.setAttribute('aria-valuenow', String(percent));
    statusText.textContent = t('statusProgress', processedTabs, data.total, refreshedTabs, failedCount, skippedTabs);
}

function handleRefreshComplete(data) {
    activeRefreshOperation = false;
    toggleOperationControls(false);

    const details = data.details || {};
    const totalTabs = Number(details.totalTabs) || tabsToRefresh.length;
    const successfulCount = Number(details.successfulTabs) || 0;
    const failedCount = Number(details.failedCount) || 0;
    const skippedCount = Number(details.skippedCount) || 0;
    const cancelled = details.cancelled === true;
    failedTabs = data.failedTabs || [];
    refreshedTabs = successfulCount;
    skippedTabs = skippedCount;
    processedTabs = Number(details.processedTabs) || successfulCount + failedCount + skippedCount;

    const finalPercent = totalTabs > 0 ? Math.round((processedTabs / totalTabs) * 100) : 0;
    progressBar.style.width = `${finalPercent}%`;
    progressBar.parentElement?.setAttribute('aria-valuenow', String(finalPercent));

    if (cancelled) {
        statusText.textContent = t('statusCancelled', processedTabs, totalTabs);
    } else if (failedCount > 0) {
        statusText.textContent = t('statusCompleteMixed', processedTabs, totalTabs, successfulCount, failedCount, skippedCount);
        showErrors();
    } else if (skippedCount > 0) {
        statusText.textContent = t('statusCompleteSkipped', successfulCount, skippedCount);
    } else {
        statusText.textContent = t('statusCompleteAll', successfulCount);
        showConfetti();
    }

    const staleBytes = Number.isFinite(details.staleBytes) ? details.staleBytes : 0;
    if (staleBytes > 0) {
        statsRunLine.style.display = 'block';
        statsRunLine.textContent = t('statsRunLine', formatBytes(staleBytes));
    } else {
        statsRunLine.style.display = 'none';
        statsRunLine.textContent = '';
    }

    initializeHistory();
    initializeStats();
}

function restoreOperationStatus() {
    chrome.runtime.sendMessage({ action: 'getOperationStatus' }, (state) => {
        if (chrome.runtime.lastError || !state) return;

        if (state.active) {
            initializeRefreshUI(state.currentTabs || [], state.tabStatuses || {});
            updateProgressUI({
                current: state.processedTabs,
                total: state.totalTabs,
                percent: state.progress,
                successful: state.refreshedTabs,
                failed: state.failedTabs,
                skipped: state.skippedTabs
            });
        } else if (state.interrupted) {
            loadingContainer.style.display = 'block';
            progressBar.style.width = `${Number(state.progress) || 0}%`;
            statusText.textContent = t('statusInterrupted');
            showOperationError(t('errorInterruptedTitle'), t('errorInterruptedDetail'));
        }
    });
}

function toggleOperationControls(active) {
    refreshButton.disabled = active;
    cancelButton.disabled = false;
    cancelButton.style.display = active ? 'inline-block' : 'none';
}

function createTabIndicators(tabs) {
    tabsContainer.textContent = '';

    tabs.forEach((tab) => {
        const tabElement = document.createElement('div');
        tabElement.className = 'tab-item';
        tabElement.id = `tab-${tab.id}`;
        tabElement.title = tab.title || t('tabFallbackTitle');
        tabElement.setAttribute('aria-label', t('tabAriaLabel', tab.title || t('tabFallbackTitle'), t('tabStatusPending')));

        if (tab.favIconUrl) {
            const image = document.createElement('img');
            image.src = tab.favIconUrl;
            image.alt = '';
            image.onerror = () => {
                image.style.display = 'none';
            };
            tabElement.appendChild(image);
        }

        const status = document.createElement('div');
        status.className = 'tab-status';

        const loading = document.createElement('div');
        loading.className = 'loading-circle';
        const success = document.createElement('div');
        success.className = 'tab-success';
        success.textContent = '✓';
        const error = document.createElement('div');
        error.className = 'tab-error';
        error.textContent = '✗';
        const skipped = document.createElement('div');
        skipped.className = 'tab-skipped';
        skipped.textContent = '–';

        status.append(loading, success, error, skipped);
        tabElement.appendChild(status);
        tabsContainer.appendChild(tabElement);
    });
}

function applyTabStatuses(statuses) {
    Object.entries(statuses).forEach(([tabId, status]) => {
        if (status !== 'pending') updateTabStatus(tabId, status);
    });
}

function updateTabStatus(tabId, status) {
    const tabElement = document.getElementById(`tab-${tabId}`);
    if (!tabElement) return;

    tabElement.querySelectorAll('.loading-circle, .tab-success, .tab-error, .tab-skipped')
        .forEach(element => {
            element.style.display = 'none';
        });

    const statusElement = tabElement.querySelector(`.tab-${status}`);
    if (statusElement) statusElement.style.display = 'block';
    tabElement.setAttribute('aria-label', t('tabAriaLabel', tabElement.title, t(TAB_STATUS_KEYS[status] || 'tabStatusPending')));
}

function showErrors() {
    errorContainer.style.display = 'block';
    errorSummary.textContent = t(failedTabs.length === 1 ? 'errorFailedSummaryOne' : 'errorFailedSummaryOther', failedTabs.length);

    if (failedTabs.length === 0) {
        errorDetails.textContent = t('errorNoTabDetails');
        return;
    }

    errorDetails.textContent = failedTabs.map((tab, index) => {
        const title = tab.title || t('tabFallbackTitle');
        const error = tab.error || t('errorUnknown');
        return t('errorTabLine', index + 1, title, error);
    }).join('\n');
}

function showOperationError(summary, details) {
    errorContainer.style.display = 'block';
    errorSummary.textContent = summary;
    errorDetails.textContent = details;
}

historyHeader.addEventListener('click', () => {
    const expanded = historyContent.style.display !== 'none';
    historyContent.style.display = expanded ? 'none' : 'block';
    historyHeader.setAttribute('aria-expanded', String(!expanded));
});

statsHeader.addEventListener('click', () => {
    const expanded = statsContent.style.display !== 'none';
    statsContent.style.display = expanded ? 'none' : 'block';
    statsHeader.setAttribute('aria-expanded', String(!expanded));
});

settingsHeader.addEventListener('click', () => {
    const expanded = settingsContent.style.display !== 'none';
    settingsContent.style.display = expanded ? 'none' : 'block';
    settingsHeader.setAttribute('aria-expanded', String(!expanded));
});

resetStats.addEventListener('click', () => {
    chrome.storage.local.remove(['cacheStats'], initializeStats);
});

function initializeHistory() {
    chrome.storage.local.get(['refreshHistory'], (result) => {
        const history = Array.isArray(result.refreshHistory) ? result.refreshHistory : [];
        historyContainer.style.display = history.length > 0 ? 'block' : 'none';
        updateHistoryDisplay(history);
    });
}

function initializeStats() {
    renderSiteAccess(siteAccessGranted);
    chrome.storage.local.get(['cacheStats'], (result) => {
        const cacheStats = result.cacheStats
            && typeof result.cacheStats === 'object'
            && !Array.isArray(result.cacheStats)
            ? result.cacheStats
            : {};
        const days = cacheStats.days
            && typeof cacheStats.days === 'object'
            && !Array.isArray(cacheStats.days)
            ? cacheStats.days
            : {};
        const todayValue = days[dayKey()];
        const today = Number.isFinite(todayValue) ? todayValue : 0;
        const lastRun = Number.isFinite(cacheStats.lastRun) ? cacheStats.lastRun : 0;
        const total = Number.isFinite(cacheStats.total) ? cacheStats.total : 0;
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

        statsToday.textContent = t('statsToday', formatBytes(today));
        statsLastRun.textContent = t('statsLastRun', formatBytes(lastRun));
        statsWeek.textContent = t('statsWeek', formatBytes(week));
        statsMonth.textContent = t('statsMonth', formatBytes(month));
        statsTotal.textContent = t('statsTotal', formatBytes(total));
        statsContainer.style.display = total > 0 ? 'block' : 'none';
    });
}

function updateHistoryDisplay(history) {
    historyContent.textContent = '';

    history.forEach((item, index) => {
        const entry = document.createElement('div');
        entry.className = 'history-entry';
        if (index < history.length - 1) entry.style.borderBottom = '1px solid #eee';

        const date = document.createElement('div');
        const parsedDate = new Date(item.timestamp);
        date.textContent = Number.isNaN(parsedDate.getTime())
            ? t('historyUnknownDate')
            : `${parsedDate.toLocaleDateString()} ${parsedDate.toLocaleTimeString()}`;

        const failedCount = Number(item.failedCount)
            || (Array.isArray(item.failedTabs) ? item.failedTabs.length : 0);
        const skippedCount = Number(item.skippedCount) || 0;
        const summary = document.createElement('div');
        summary.textContent = item.cancelled
            ? t('historyEntryCancelled', item.successfulTabs || 0, item.totalTabs || 0)
            : t('historyEntrySummary', item.successfulTabs || 0, item.totalTabs || 0, failedCount, skippedCount);
        summary.className = failedCount > 0 ? 'history-failure' : 'history-success';

        entry.append(date, summary);
        historyContent.appendChild(entry);
    });
}

function showConfetti() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    confettiElement.style.display = 'block';
    const colors = ['#4285f4', '#0f9d58', '#f4b400', '#db4437'];

    for (let index = 0; index < 60; index++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.left = `${Math.random() * 100}%`;
        confetti.style.animationDuration = `${Math.random() + 2}s`;
        confettiElement.appendChild(confetti);
    }

    setTimeout(() => {
        confettiElement.style.display = 'none';
        confettiElement.textContent = '';
    }, 3000);
}
