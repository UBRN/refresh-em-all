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
        refreshButton.addEventListener('click', startStressTest);
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
    
    // Start refresh operation
    startRefreshOperation();
    
    chrome.tabs.query({}, (tabs) => {
        tabsToRefresh = tabs.filter(tab => !!tab.id);
        refreshedTabs = 0;
        failedTabs = [];
        startTime = new Date();
        
        // Show loading container and initialize UI
        loadingContainer.style.display = 'block';
        progressBar.style.width = '0%';
        statusText.textContent = `Stress Test: Iteration ${stressTestIterations}/${maxStressTestIterations}`;
        errorContainer.style.display = 'none';
        
        // Create tab indicators
        createTabIndicators(tabsToRefresh);
        
        // Start refreshing tabs with stress test flag
        refreshTabsSequentially(tabsToRefresh, true);
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

// Function to refresh tabs sequentially
function refreshTabsSequentially(tabs, isStressTest = false) {
    let currentIndex = 0;
    
    function refreshNextTab() {
        if (currentIndex >= tabs.length) {
            // All tabs have been processed
            const allSuccess = failedTabs.length === 0;
            
            if (isStressTest) {
                statusText.textContent = allSuccess 
                    ? `Stress Test: Iteration ${stressTestIterations}/${maxStressTestIterations} completed` 
                    : `Stress Test: Failed on iteration ${stressTestIterations}/${maxStressTestIterations}`;
            } else {
                statusText.textContent = allSuccess 
                    ? `All ${tabs.length} tabs refreshed successfully!` 
                    : `Refreshed ${refreshedTabs}/${tabs.length} tabs with ${failedTabs.length} errors`;
            }
            
            if (!allSuccess) {
                showErrors();
            }
            
            endRefreshOperation(allSuccess);
            return;
        }
        
        const tab = tabs[currentIndex];
        const tabElement = document.getElementById(`tab-${tab.id}`);
        
        refreshTab(tab)
            .then(() => {
                // Success
                refreshedTabs++;
                updateTabStatus(tabElement, 'success');
            })
            .catch((error) => {
                // Error
                failedTabs.push({
                    tabId: tab.id,
                    title: tab.title || 'Unknown tab',
                    url: tab.url,
                    error: error.message || 'Unknown error'
                });
                updateTabStatus(tabElement, 'error');
                
                // Report the error
                reportRefreshError(tab, error);
            })
            .finally(() => {
                // Update progress
                currentIndex++;
                updateProgress(currentIndex, tabs.length);
                
                // Process next tab
                setTimeout(refreshNextTab, isStressTest ? 50 : 100); // Faster for stress tests
            });
    }
    
    // Start the sequence
    refreshNextTab();
}

// Function to report tab refresh errors
function reportRefreshError(tab, error) {
    chrome.runtime.sendMessage({
        action: 'reportError',
        errorType: 'tab_refresh_error',
        errorDetails: {
            tabId: tab.id,
            tabTitle: tab.title,
            tabUrl: tab.url,
            errorMessage: error.message || 'Unknown error',
            errorStack: error.stack,
            timestamp: new Date().toISOString()
        }
    });
}

// Function to refresh a single tab
function refreshTab(tab) {
    return new Promise((resolve, reject) => {
        try {
            // Check if tab is discarded (dormant)
            if (tab.discarded) {
                // For discarded tabs, we need to activate them first
                chrome.tabs.update(tab.id, { active: true }, () => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    
                    // Then reload without cache
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        
                        resolve();
                    });
                });
            } else {
                // For active tabs, we'll use a custom reload approach
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    function: preserveMediaState,
                }).then(() => {
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        
                        resolve();
                    });
                }).catch((error) => {
                    // Fallback for tabs where we can't execute scripts
                    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        
                        resolve();
                    });
                });
            }
        } catch (error) {
            reject(error);
        }
    });
}

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

// Function to save media playback state before refresh
function preserveMediaState() {
    // Store playback states in sessionStorage
    const videos = document.querySelectorAll('video');
    const audios = document.querySelectorAll('audio');
    
    const mediaStates = {};
    
    videos.forEach((video, index) => {
        mediaStates[`video_${index}`] = {
            paused: video.paused,
            currentTime: video.currentTime,
            src: video.src
        };
    });
    
    audios.forEach((audio, index) => {
        mediaStates[`audio_${index}`] = {
            paused: audio.paused,
            currentTime: audio.currentTime,
            src: audio.src
        };
    });
    
    // Save state to sessionStorage
    sessionStorage.setItem('refreshEmAllMediaState', JSON.stringify(mediaStates));
}
