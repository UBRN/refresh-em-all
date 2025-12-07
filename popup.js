// DOM Elements
let refreshButton = document.getElementById('refreshAll');
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
const errorReportingToggle = document.getElementById('errorReportingToggle');
const pendingErrorsContainer = document.getElementById('pendingErrorsContainer');
const pendingErrorCount = document.getElementById('pendingErrorCount');
const reportErrorsBtn = document.getElementById('reportErrorsBtn');

// Error reporting constants
const ERROR_REPORTING_ENDPOINT = "https://your-error-reporting-endpoint.com/api/errors";

// State variables
let activeRefreshOperation = false;
let tabsToRefresh = [];
let refreshedTabs = 0;
let failedTabs = [];
let startTime;
let stressTestMode = false;
let stressTestIterations = 0;
let maxStressTestIterations = 50; // Maximum number of iterations for stress testing

// Initialize displays
initializeHistory();
initializeSettings();
updatePendingErrorReportsCount();

// Error and exception tracking
window.addEventListener('error', (event) => {
    const errorDetails = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error ? event.error.stack : null,
        timestamp: new Date().toISOString(),
        context: 'popup'
    };

    chrome.runtime.sendMessage({
        action: 'reportError',
        errorType: 'popup_error',
        errorDetails
    });
});

// Button click event listener
refreshButton.addEventListener('click', () => {
    if (activeRefreshOperation) return;

    // Send message to background to start refresh
    chrome.runtime.sendMessage({ action: 'startRefresh' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError);
            return;
        }

        if (response && !response.success) {
            console.log('Refresh start failed:', response.message);
        }
    });

    // We don't start local logic here, we wait for 'refreshStarted' or 'refreshProgress' events
    // or we can optimistically set UI state if we assume success.
    // However, it's better to wait for background confirmation or events.
});

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'refreshStarted') {
        const tabs = message.tabs || [];
        initializeRefreshUI(tabs);
    }
    else if (message.action === 'refreshProgress') {
        updateProgressUI(message);
    }
    else if (message.action === 'refreshComplete') {
        handleRefreshComplete(message);
    }
    else if (message.action === 'tabSucceeded') {
        const tabElement = document.getElementById(`tab-${message.tabId}`);
        updateTabStatus(tabElement, 'success');
    }
    else if (message.action === 'tabFailed') {
        const tabElement = document.getElementById(`tab-${message.tabId}`);
        updateTabStatus(tabElement, 'error');
    }
});

function initializeRefreshUI(tabs) {
    activeRefreshOperation = true;
    toggleInputState(false);

    tabsToRefresh = tabs;
    refreshedTabs = 0;
    failedTabs = [];
    startTime = new Date();

    // Show loading container and initialize UI
    loadingContainer.style.display = 'block';
    progressBar.style.width = '0%';
    statusText.textContent = `Refreshing 0/${tabs.length} tabs...`;
    errorContainer.style.display = 'none';

    // Create tab indicators
    createTabIndicators(tabs);
}

function updateProgressUI(data) {
    if (!activeRefreshOperation) return;

    refreshedTabs = data.current; // Actually current means processed? background says 'current' param in updateProgress is 'refreshedTabs'. 
    // Wait, background sending: current (refreshed), total, percent.

    const percent = data.percent;
    progressBar.style.width = `${percent}%`;
    statusText.textContent = `Refreshing ${data.current}/${data.total} tabs...`;

    // We don't know exactly WHICH tab finished from 'refreshProgress' event in background.js current implementation
    // unless we update background to send that info.
    // But we can update the list if we tracked it?
    // Background doesn't send WHICH tab succeeded in "refreshProgress".
    // It sends 'failedTabs' count. 
    // This is a limitation. The previous popup logic updated each tab's icon.
    // If we want to keep that feature, background needs to send "tabComplete" events.
}

function handleRefreshComplete(data) {
    activeRefreshOperation = false;
    toggleInputState(true);

    const success = data.success;
    const details = data.details || {};

    failedTabs = data.failedTabs || [];

    if (success && !stressTestMode) {
        showConfetti();
        statusText.textContent = `All ${details.totalTabs} tabs refreshed successfully!`;
    } else if (!success) {
        statusText.textContent = `Refreshed ${details.successfulTabs}/${details.totalTabs} tabs with ${details.failedCount} errors`;
        showErrors();
    }

    // Update history locally? Background already saved it.
    // We should reload history display.
    initializeHistory();

    // Show history container
    historyContainer.style.display = 'block';

    // Continue stress test if in stress test mode
    if (stressTestMode) {
        continueStressTest();
    }
}

function toggleInputState(enabled) {
    refreshButton.disabled = !enabled;
}

// Toggle history display
historyHeader.addEventListener('click', () => {
    historyContent.style.display = historyContent.style.display === 'none' ? 'block' : 'none';
});

// Toggle settings display
settingsHeader.addEventListener('click', () => {
    settingsContent.style.display = settingsContent.style.display === 'none' ? 'block' : 'none';
});

// Error reporting toggle
errorReportingToggle.addEventListener('change', () => {
    chrome.storage.sync.set({
        errorReportingConsent: errorReportingToggle.checked
    });

    updatePendingErrorReportsCount();
});

// Send pending error reports button
reportErrorsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'sendPendingErrorReports' }, (response) => {
        if (response && response.success) {
            updatePendingErrorReportsCount();
        }
    });
});

// Double-click on settings header enables stress test mode (hidden feature for developers)
let settingsHeaderClickCount = 0;
let settingsHeaderClickTimer;
settingsHeader.addEventListener('click', () => {
    settingsHeaderClickCount++;

    if (settingsHeaderClickCount === 5) {
        enableStressTestMode();
        settingsHeaderClickCount = 0;
        clearTimeout(settingsHeaderClickTimer);
    } else {
        clearTimeout(settingsHeaderClickTimer);
        settingsHeaderClickTimer = setTimeout(() => {
            settingsHeaderClickCount = 0;
        }, 1000);
    }
});

// Function to enable stress test mode
function enableStressTestMode() {
    if (confirm('Enable Stress Test Mode? This will repeatedly refresh all tabs until an error occurs or the maximum iterations are reached.')) {
        stressTestMode = true;
        stressTestIterations = 0;

        // Change button text to indicate stress test mode
        refreshButton.textContent = 'Start Stress Test';
        refreshButton.style.backgroundColor = '#db4437';

        // Store original click handler
        const originalClickHandler = refreshButton.onclick;

        // Change button behavior for stress test
        refreshButton.removeEventListener('click', originalClickHandler);
        // We will just change text/style, the click will trigger startStressTest which calls startRefresh
        refreshButton.onclick = startStressTest;
    }
}

// Stress test function
function startStressTest() {
    if (activeRefreshOperation) return;

    // Show stress test warning
    const iterations = prompt('Enter maximum number of iterations (1-100):', '50');
    if (iterations === null) return;

    maxStressTestIterations = Math.min(Math.max(parseInt(iterations) || 50, 1), 100);

    // Start the stress test
    statusText.textContent = `Stress Test: Iteration 1/${maxStressTestIterations}`;
    runStressTestIteration();
}

// Run a single stress test iteration
function runStressTestIteration() {
    stressTestIterations++;
    statusText.textContent = `Stress Test: Iteration ${stressTestIterations}/${maxStressTestIterations}`;

    // Start refresh operation via background
    chrome.runtime.sendMessage({ action: 'startRefresh' }, (response) => {
        // UI initialization will happen in response to 'refreshStarted'
    });
}

// Function to continue or stop stress test
function continueStressTest() {
    // Check if we should continue
    if (stressTestMode && stressTestIterations < maxStressTestIterations && failedTabs.length === 0) {
        // Continue after a short delay
        setTimeout(runStressTestIteration, 2000);
    } else {
        // End stress test
        stressTestMode = false;
        refreshButton.textContent = 'Refresh All Tabs';
        refreshButton.style.backgroundColor = '#4285f4';

        // Show results
        if (failedTabs.length > 0) {
            statusText.textContent = `Stress Test Failed on Iteration ${stressTestIterations}/${maxStressTestIterations}`;
        } else {
            statusText.textContent = `Stress Test Completed: ${stressTestIterations} iterations`;
        }

        // Reset button behavior
        refreshButton.removeEventListener('click', startStressTest);
        // Re-add the original click handler by cloning and replacing the button
        const newButton = refreshButton.cloneNode(true);
        refreshButton.parentNode.replaceChild(newButton, refreshButton);
        // Update our reference and attach the original event listener
        refreshButton = newButton;
        refreshButton.addEventListener('click', () => {
            if (activeRefreshOperation) return;

            startRefreshOperation();

            chrome.tabs.query({}, (tabs) => {
                tabsToRefresh = tabs.filter(tab => !!tab.id);
                refreshedTabs = 0;
                failedTabs = [];
                startTime = new Date();

                // Show loading container and initialize UI
                loadingContainer.style.display = 'block';
                progressBar.style.width = '0%';
                statusText.textContent = `Refreshing 0/${tabsToRefresh.length} tabs...`;
                errorContainer.style.display = 'none';

                // Create tab indicators
                createTabIndicators(tabsToRefresh);

                // Start refreshing tabs one by one
                refreshTabsSequentially(tabsToRefresh);
            });
        });
    }
}

// Function to initialize settings
function initializeSettings() {
    chrome.storage.sync.get(['errorReportingConsent'], (result) => {
        errorReportingToggle.checked = result.errorReportingConsent === true;
    });
}

// Function to update the pending error reports count
function updatePendingErrorReportsCount() {
    chrome.storage.local.get(['pendingErrorReports'], (result) => {
        const pendingReports = result.pendingErrorReports || [];

        if (pendingReports.length > 0 && errorReportingToggle.checked) {
            pendingErrorsContainer.style.display = 'block';
            pendingErrorCount.textContent = pendingReports.length;
        } else {
            pendingErrorsContainer.style.display = 'none';
        }
    });
}

// Function to start the refresh operation
function startRefreshOperation() {
    activeRefreshOperation = true;
    refreshButton.disabled = true;
}

// Function to end the refresh operation
function endRefreshOperation(success) {
    activeRefreshOperation = false;
    refreshButton.disabled = false;

    if (success && !stressTestMode) {
        showConfetti();
    }

    // Save operation to history
    saveToHistory({
        timestamp: startTime,
        totalTabs: tabsToRefresh.length,
        successfulTabs: refreshedTabs,
        failedTabs: failedTabs
    });

    // Show history container
    historyContainer.style.display = 'block';

    // Continue stress test if in stress test mode
    if (stressTestMode) {
        continueStressTest();
    }
}

// Function to create visual indicators for each tab
function createTabIndicators(tabs) {
    tabsContainer.innerHTML = '';

    tabs.forEach((tab, index) => {
        const tabElement = document.createElement('div');
        tabElement.className = 'tab-item';
        tabElement.id = `tab-${tab.id}`;
        tabElement.title = tab.title || 'Tab';

        // Add favicon if available
        if (tab.favIconUrl) {
            const img = document.createElement('img');
            img.src = tab.favIconUrl;
            img.onerror = () => {
                img.style.display = 'none';
            };
            tabElement.appendChild(img);
        }

        // Add status indicators
        const statusDiv = document.createElement('div');
        statusDiv.className = 'tab-status';

        const loadingCircle = document.createElement('div');
        loadingCircle.className = 'loading-circle';

        const successIcon = document.createElement('div');
        successIcon.className = 'tab-success';
        successIcon.innerHTML = '✓';

        const errorIcon = document.createElement('div');
        errorIcon.className = 'tab-error';
        errorIcon.innerHTML = '✗';

        statusDiv.appendChild(loadingCircle);
        statusDiv.appendChild(successIcon);
        statusDiv.appendChild(errorIcon);

        tabElement.appendChild(statusDiv);
        tabsContainer.appendChild(tabElement);
    });
}

// Deleted refreshTabsSequentially, reportRefreshError, refreshTab, preserveMediaState because functionality moved to background.js
// But wait, createTabIndicators uses 'tabsToRefresh'.
// And updateTabStatus is used.
// If background doesn't send per-tab updates, we can't update individual tab icons (green check/red X).
// I should update background.js to send 'tabSuccess'/'tabFailure' events?
// For now, I will leave these functions deleted and accept that per-tab status might not update live, 
// OR I will simply rely on the 'refreshProgress' to update the bar, and 'refreshComplete' to update errors.
// The user spec says: "Granular tab list showing status indicators (Loading, Success ✓, Error ✗) for every individual tab."
// So I MUST update background.js to support this. I cannot delete this without breaking the spec.


// Function to update the progress bar and status text
function updateProgress(current, total) {
    const percentage = Math.min(100, Math.round((current / total) * 100));
    progressBar.style.width = `${percentage}%`;
    statusText.textContent = `Refreshing ${refreshedTabs}/${total} tabs...`;
}

// Function to update the status of a tab indicator
function updateTabStatus(tabElement, status) {
    if (!tabElement) return;

    const statusDiv = tabElement.querySelector('.tab-status');
    const loadingCircle = statusDiv.querySelector('.loading-circle');
    const successIcon = statusDiv.querySelector('.tab-success');
    const errorIcon = statusDiv.querySelector('.tab-error');

    loadingCircle.style.display = 'none';

    if (status === 'success') {
        successIcon.style.display = 'block';
        errorIcon.style.display = 'none';
    } else if (status === 'error') {
        successIcon.style.display = 'none';
        errorIcon.style.display = 'block';
    }
}

// Function to show error summary and details
function showErrors() {
    errorContainer.style.display = 'block';

    errorSummary.textContent = `Failed to refresh ${failedTabs.length} tab${failedTabs.length > 1 ? 's' : ''}.`;

    let detailsText = 'Errors:';
    failedTabs.forEach((tab, index) => {
        detailsText += `\n${index + 1}. "${tab.title}" (${tab.url}): ${tab.error}`;
    });

    // Add troubleshooting tips
    detailsText += '\n\nTroubleshooting tips:';
    detailsText += '\n• Chrome extensions cannot refresh certain system pages';
    detailsText += '\n• Check if your browser is in an offline mode';
    detailsText += '\n• Try closing and reopening the tab manually';

    errorDetails.textContent = detailsText;
}

// Function to create and show confetti animation
function showConfetti() {
    confettiElement.style.display = 'block';

    const colors = ['#4285f4', '#0f9d58', '#f4b400', '#db4437'];
    const confettiCount = 100;

    for (let i = 0; i < confettiCount; i++) {
        createConfettiPiece(colors[Math.floor(Math.random() * colors.length)]);
    }

    // Hide confetti after animation
    setTimeout(() => {
        confettiElement.style.display = 'none';
        confettiElement.innerHTML = '';
    }, 3000);
}

// Function to create a single confetti piece
function createConfettiPiece(color) {
    const confetti = document.createElement('div');
    confetti.style.position = 'absolute';
    confetti.style.width = '10px';
    confetti.style.height = '10px';
    confetti.style.backgroundColor = color;
    confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.top = -20 + 'px';
    confetti.style.opacity = Math.random() + 0.5;
    confetti.style.transform = `rotate(${Math.random() * 360}deg)`;

    // Animation
    confetti.style.animation = `fall ${Math.random() * 3 + 2}s linear forwards`;

    // Add keyframes for fall animation
    const styleSheet = document.styleSheets[0];
    if (!document.querySelector('style#confetti-style')) {
        const style = document.createElement('style');
        style.id = 'confetti-style';
        style.textContent = `
            @keyframes fall {
                to {
                    top: 100%;
                    transform: rotate(${Math.random() * 360 + 720}deg);
                }
            }
        `;
        document.head.appendChild(style);
    }

    confettiElement.appendChild(confetti);
}

// History management functions
function initializeHistory() {
    chrome.storage.sync.get(['refreshHistory'], (result) => {
        if (result.refreshHistory && result.refreshHistory.length > 0) {
            historyContainer.style.display = 'block';
            updateHistoryDisplay(result.refreshHistory);
        }
    });
}

function saveToHistory(operation) {
    chrome.storage.sync.get(['refreshHistory'], (result) => {
        let history = result.refreshHistory || [];

        // Add new operation to history
        history.unshift({
            timestamp: operation.timestamp.toISOString(),
            totalTabs: operation.totalTabs,
            successfulTabs: operation.successfulTabs,
            failedTabs: operation.failedTabs,
        });

        // Limit history to 10 entries
        if (history.length > 10) {
            history = history.slice(0, 10);
        }

        // Save to storage
        chrome.storage.sync.set({ refreshHistory: history }, () => {
            updateHistoryDisplay(history);
        });
    });
}

function updateHistoryDisplay(history) {
    historyContent.innerHTML = '';

    history.forEach((item, index) => {
        const entry = document.createElement('div');
        entry.style.borderBottom = index < history.length - 1 ? '1px solid #eee' : 'none';
        entry.style.padding = '5px 0';

        const date = new Date(item.timestamp);
        const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;

        const statusText = item.failedTabs.length === 0
            ? `<span style="color: #0f9d58;">All tabs refreshed successfully</span>`
            : `<span style="color: #db4437;">${item.failedTabs.length} tabs failed</span>`;

        entry.innerHTML = `
            <div>${formattedDate}</div>
            <div>Refreshed ${item.successfulTabs}/${item.totalTabs} tabs - ${statusText}</div>
        `;

        // Add error details if there were failures
        if (item.failedTabs.length > 0) {
            const detailsButton = document.createElement('button');
            detailsButton.textContent = 'Show details';
            detailsButton.style.fontSize = '11px';
            detailsButton.style.padding = '2px 5px';
            detailsButton.style.marginTop = '3px';

            const detailsContent = document.createElement('div');
            detailsContent.style.display = 'none';
            detailsContent.style.fontSize = '11px';
            detailsContent.style.marginTop = '5px';
            detailsContent.style.marginLeft = '10px';

            let detailsText = '';
            item.failedTabs.forEach((tab, i) => {
                detailsText += `${i + 1}. "${tab.title}" - ${tab.error}<br>`;
            });
            detailsContent.innerHTML = detailsText;

            detailsButton.addEventListener('click', () => {
                detailsContent.style.display = detailsContent.style.display === 'none' ? 'block' : 'none';
                detailsButton.textContent = detailsContent.style.display === 'none' ? 'Show details' : 'Hide details';
            });

            entry.appendChild(detailsButton);
            entry.appendChild(detailsContent);
        }

        historyContent.appendChild(entry);
    });
}

// preserveMediaState removed as it is handled in background.js

/**
 * Checks if DevTools might be causing a debugger pause
 * and shows a notification if needed
 */
function checkForDebuggerIssue() {
    // Only show this in development mode or if there's been a previous pause issue
    chrome.storage.local.get(['debuggerPauseDetected'], (result) => {
        if (result.debuggerPauseDetected) {
            // Show the notification with instructions
            showDebuggerPauseNotification();
        }
    });

    // Listen for errors that might indicate a debugger pause
    window.addEventListener('error', (event) => {
        if (event.message && (
            event.message.includes('debugger') ||
            event.message.includes('pause') ||
            event.message.includes('break')
        )) {
            // Mark that we've detected the issue
            chrome.storage.local.set({ debuggerPauseDetected: true });
            showDebuggerPauseNotification();
        }
    });
}

/**
 * Shows a notification about how to fix the debugger pause issue
 */
function showDebuggerPauseNotification() {
    const notificationContainer = document.createElement('div');
    notificationContainer.className = 'notification debugger-notification';
    notificationContainer.innerHTML = `
        <div class="notification-content">
            <strong>Developer Tools Issue Detected</strong>
            <p>If tabs get stuck with "Paused in debugger", please:</p>
            <ol>
                <li>Open Chrome DevTools (F12)</li>
                <li>Go to Sources tab</li>
                <li>Find the pause button at the bottom</li>
                <li>Click it until it turns grey</li>
            </ol>
            <button class="notification-dismiss">Dismiss</button>
        </div>
    `;

    document.body.appendChild(notificationContainer);

    // Add styles if not already present
    if (!document.getElementById('notification-styles')) {
        const styles = document.createElement('style');
        styles.id = 'notification-styles';
        styles.textContent = `
            .notification {
                position: fixed;
                bottom: 10px;
                right: 10px;
                background: #fff;
                border: 1px solid #ccc;
                border-radius: 5px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                z-index: 1000;
                max-width: 300px;
            }
            .debugger-notification {
                background-color: #f8f9fa;
                border-left: 4px solid #3367d6;
            }
            .notification-content {
                padding: 12px;
            }
            .notification-content p {
                margin: 8px 0;
            }
            .notification-content ol {
                margin: 8px 0;
                padding-left: 20px;
            }
            .notification-dismiss {
                background: #3367d6;
                color: white;
                border: none;
                padding: 5px 10px;
                border-radius: 3px;
                cursor: pointer;
                float: right;
                margin-top: 8px;
            }
        `;
        document.head.appendChild(styles);
    }

    // Add dismiss functionality
    const dismissButton = notificationContainer.querySelector('.notification-dismiss');
    dismissButton.addEventListener('click', () => {
        notificationContainer.remove();
    });
}

// Call this at startup
document.addEventListener('DOMContentLoaded', function () {
    // Check for debugger issues
    checkForDebuggerIssue();
});
