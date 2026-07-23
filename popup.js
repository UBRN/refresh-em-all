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

let activeRefreshOperation = false;
let tabsToRefresh = [];
let processedTabs = 0;
let refreshedTabs = 0;
let failedTabs = [];
let skippedTabs = 0;
let stressTestMode = false;
let stressTestRunning = false;
let stressTestIterations = 0;
let maxStressTestIterations = 50;

initializeHistory();
restoreOperationStatus();

refreshButton.addEventListener('click', () => {
    if (activeRefreshOperation) return;

    if (stressTestMode && !stressTestRunning) {
        startStressTest();
        return;
    }

    requestRefresh();
});

cancelButton.addEventListener('click', () => {
    if (!activeRefreshOperation) return;

    cancelButton.disabled = true;
    statusText.textContent = 'Cancelling refresh…';
    chrome.runtime.sendMessage({ action: 'cancelOperation' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
            cancelButton.disabled = false;
            statusText.textContent = 'Unable to cancel the current refresh.';
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
    statusText.textContent = stressTestRunning
        ? `Stress test ${stressTestIterations}/${maxStressTestIterations}: starting…`
        : 'Starting refresh…';

    chrome.runtime.sendMessage({ action: 'startRefresh' }, (response) => {
        const errorMessage = chrome.runtime.lastError?.message || response?.message;
        if (errorMessage || !response?.success) {
            activeRefreshOperation = false;
            toggleOperationControls(false);
            statusText.textContent = `Unable to start refresh: ${errorMessage || 'Unknown error'}`;
            showOperationError('Refresh could not start', errorMessage || 'Unknown error');
            finishStressTest(false);
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
    statusText.textContent = stressTestRunning
        ? `Stress test ${stressTestIterations}/${maxStressTestIterations}: refreshing 0/${tabs.length}…`
        : `Processed 0/${tabs.length} tabs…`;
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
    const prefix = stressTestRunning
        ? `Stress test ${stressTestIterations}/${maxStressTestIterations}: `
        : '';
    statusText.textContent = `${prefix}processed ${processedTabs}/${data.total} — ${refreshedTabs} refreshed, ${failedCount} failed, ${skippedTabs} skipped`;
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
        statusText.textContent = `Refresh cancelled after ${processedTabs}/${totalTabs} tabs.`;
    } else if (failedCount > 0) {
        statusText.textContent = `Processed ${processedTabs}/${totalTabs}: ${successfulCount} refreshed, ${failedCount} failed, ${skippedCount} skipped.`;
        showErrors();
    } else if (skippedCount > 0) {
        statusText.textContent = `Refreshed ${successfulCount} tabs; skipped ${skippedCount} restricted tabs.`;
    } else {
        statusText.textContent = `All ${successfulCount} tabs refreshed successfully!`;
        if (!stressTestRunning) showConfetti();
    }

    initializeHistory();

    if (stressTestRunning) {
        continueStressTest(!cancelled && failedCount === 0);
    }
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
            statusText.textContent = state.message || 'The previous refresh was interrupted.';
            showOperationError('Refresh interrupted', 'Start a new refresh to continue.');
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
        tabElement.title = tab.title || 'Tab';
        tabElement.setAttribute('aria-label', `${tab.title || 'Tab'}: pending`);

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
    tabElement.setAttribute('aria-label', `${tabElement.title}: ${status}`);
}

function showErrors() {
    errorContainer.style.display = 'block';
    errorSummary.textContent = `Failed to refresh ${failedTabs.length} tab${failedTabs.length === 1 ? '' : 's'}.`;

    if (failedTabs.length === 0) {
        errorDetails.textContent = 'No tab-specific error details were returned.';
        return;
    }

    errorDetails.textContent = failedTabs.map((tab, index) => {
        const title = tab.title || 'Tab';
        const error = tab.error || 'Unknown error';
        return `${index + 1}. ${title}: ${error}`;
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
    trackStressTestActivation();
});

let settingsHeaderClickCount = 0;
let settingsHeaderClickTimer;

function trackStressTestActivation() {
    settingsHeaderClickCount++;
    clearTimeout(settingsHeaderClickTimer);

    if (settingsHeaderClickCount === 5) {
        settingsHeaderClickCount = 0;
        enableStressTestMode();
        return;
    }

    settingsHeaderClickTimer = setTimeout(() => {
        settingsHeaderClickCount = 0;
    }, 1500);
}

function enableStressTestMode() {
    if (!confirm('Enable Stress Test Mode? This repeatedly refreshes all tabs until an error occurs or the iteration limit is reached.')) return;

    stressTestMode = true;
    stressTestRunning = false;
    stressTestIterations = 0;
    refreshButton.textContent = 'Start Stress Test';
    refreshButton.style.backgroundColor = '#db4437';
}

function startStressTest() {
    const iterations = prompt('Enter maximum number of iterations (1-100):', '50');
    if (iterations === null) return;

    maxStressTestIterations = Math.min(Math.max(Number.parseInt(iterations, 10) || 50, 1), 100);
    stressTestRunning = true;
    stressTestIterations = 0;
    runStressTestIteration();
}

function runStressTestIteration() {
    if (!stressTestRunning) return;
    stressTestIterations++;
    requestRefresh();
}

function continueStressTest(iterationSucceeded) {
    if (iterationSucceeded && stressTestIterations < maxStressTestIterations) {
        setTimeout(runStressTestIteration, 2000);
        return;
    }

    finishStressTest(iterationSucceeded);
}

function finishStressTest(success) {
    if (!stressTestMode && !stressTestRunning) return;

    const completedIterations = stressTestIterations;
    stressTestRunning = false;
    stressTestMode = false;
    refreshButton.textContent = 'Refresh All Tabs';
    refreshButton.style.backgroundColor = '#4285f4';

    if (completedIterations > 0) {
        statusText.textContent = success
            ? `Stress test completed: ${completedIterations} iteration${completedIterations === 1 ? '' : 's'}.`
            : `Stress test stopped after iteration ${completedIterations}.`;
    }
}

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
            ? 'Unknown date'
            : `${parsedDate.toLocaleDateString()} ${parsedDate.toLocaleTimeString()}`;

        const failedCount = Number(item.failedCount)
            || (Array.isArray(item.failedTabs) ? item.failedTabs.length : 0);
        const skippedCount = Number(item.skippedCount) || 0;
        const summary = document.createElement('div');
        summary.textContent = item.cancelled
            ? `Cancelled: ${item.successfulTabs || 0}/${item.totalTabs || 0} refreshed`
            : `${item.successfulTabs || 0}/${item.totalTabs || 0} refreshed, ${failedCount} failed, ${skippedCount} skipped`;
        summary.className = failedCount > 0 ? 'history-failure' : 'history-success';

        entry.append(date, summary);
        historyContent.appendChild(entry);
    });
}

function showConfetti() {
    confettiElement.style.display = 'block';
    const colors = ['#4285f4', '#0f9d58', '#f4b400', '#db4437'];

    for (let index = 0; index < 60; index++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.left = `${Math.random() * 100}%`;
        confetti.style.animationDuration = `${Math.random() * 2 + 2}s`;
        confettiElement.appendChild(confetti);
    }

    setTimeout(() => {
        confettiElement.style.display = 'none';
        confettiElement.textContent = '';
    }, 3000);
}
