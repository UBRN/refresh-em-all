function t(key, ...substitutions) {
    return chrome.i18n.getMessage(
        key,
        substitutions.length > 0 ? substitutions.map(String) : undefined
    );
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
const tabsContainer = document.getElementById('tabsContainer');
const errorContainer = document.getElementById('errorContainer');
const errorSummary = document.getElementById('errorSummary');
const errorDetails = document.getElementById('errorDetails');
const historyContainer = document.getElementById('historyContainer');
const historyHeader = document.getElementById('historyHeader');
const historyContent = document.getElementById('historyContent');
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
    ['#settingsHeader', 'settingsToggle'],
    ['.privacy-info', 'privacyNotice']
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

initializeHistory();
restoreOperationStatus();

refreshButton.addEventListener('click', () => {
    if (activeRefreshOperation) return;

    requestRefresh();
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

    initializeHistory();

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

settingsHeader.addEventListener('click', () => {
    const expanded = settingsContent.style.display !== 'none';
    settingsContent.style.display = expanded ? 'none' : 'block';
    settingsHeader.setAttribute('aria-expanded', String(!expanded));
});

function initializeHistory() {
    chrome.storage.local.get(['refreshHistory'], (result) => {
        const history = Array.isArray(result.refreshHistory) ? result.refreshHistory : [];
        historyContainer.style.display = history.length > 0 ? 'block' : 'none';
        updateHistoryDisplay(history);
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
