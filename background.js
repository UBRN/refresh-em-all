// State tracking
let activeRefreshOperation = false;
let tabsToRefresh = [];
let refreshedTabs = 0;
let failedTabs = [];
let startTime;

// Constants for error reporting
const ERROR_REPORTING_ENDPOINT = "https://your-error-reporting-endpoint.com/api/errors";
const ERROR_REPORTING_ENABLED = true; // Can be toggled in settings

// Setup error handling for uncaught errors
self.addEventListener('error', (event) => {
    const errorDetails = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error ? event.error.stack : null,
        timestamp: new Date().toISOString(),
        browserInfo: navigator.userAgent,
        extensionVersion: chrome.runtime.getManifest().version
    };
    
    reportError('uncaught_error', errorDetails);
});

// Setup error handling for unhandled promise rejections
self.addEventListener('unhandledrejection', (event) => {
    const errorDetails = {
        message: event.reason ? (event.reason.message || 'Unhandled Promise Rejection') : 'Unhandled Promise Rejection',
        stack: event.reason && event.reason.stack,
        timestamp: new Date().toISOString(),
        browserInfo: navigator.userAgent,
        extensionVersion: chrome.runtime.getManifest().version
    };
    
    reportError('unhandled_promise_rejection', errorDetails);
});

// Listen for the toolbar icon click
chrome.action.onClicked.addListener(() => {
    if (activeRefreshOperation) return;
    
    // Start refresh operation
    startRefreshOperation();
    
    chrome.tabs.query({}, (tabs) => {
        tabsToRefresh = tabs.filter(tab => !!tab.id);
        refreshedTabs = 0;
        failedTabs = [];
        startTime = new Date();
        
        // Start refreshing tabs sequentially for better performance and user experience
        refreshTabsSequentially(tabsToRefresh);
    });
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'reportError') {
        // Handle error reports from popup or content scripts
        reportError(message.errorType, message.errorDetails);
        sendResponse({ success: true });
        return true; // Indicates async response
    } 
    else if (message.action === 'sendPendingErrorReports') {
        // Send pending error reports
        attemptToSendPendingErrorReports()
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: false }));
        return true; // Indicates async response
    }
});

// Function to report errors to the server
function reportError(errorType, errorDetails) {
    if (!ERROR_REPORTING_ENABLED) return;
    
    // Get user consent for error reporting from storage
    chrome.storage.sync.get(['errorReportingConsent'], (result) => {
        const hasConsent = result.errorReportingConsent === true;
        
        if (hasConsent) {
            // Add extension ID and browser info, but no personal identifiable information
            const reportData = {
                errorType,
                ...errorDetails,
                extensionId: chrome.runtime.id
            };
            
            // Attempt to send error to reporting service
            fetch(ERROR_REPORTING_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(reportData)
            }).catch(err => {
                // If we can't report the error, store it locally for later reporting
                storeErrorForLaterReporting(errorType, errorDetails);
            });
        } else {
            // Store error locally without reporting
            storeErrorForLaterReporting(errorType, errorDetails);
        }
    });
}

// Store errors locally if they can't be reported immediately
function storeErrorForLaterReporting(errorType, errorDetails) {
    chrome.storage.local.get(['pendingErrorReports'], (result) => {
        const pendingReports = result.pendingErrorReports || [];
        pendingReports.push({
            errorType,
            ...errorDetails,
            storedAt: new Date().toISOString()
        });
        
        // Limit stored errors to prevent excessive storage use
        if (pendingReports.length > 50) {
            pendingReports.splice(0, pendingReports.length - 50);
        }
        
        chrome.storage.local.set({ pendingErrorReports: pendingReports });
    });
}

// Attempt to send pending error reports when extension is online
chrome.runtime.onStartup.addListener(() => {
    attemptToSendPendingErrorReports();
});

// Also try periodically during runtime
setInterval(() => {
    attemptToSendPendingErrorReports().catch(() => {
        // Silently handle failures
    });
}, 30 * 60 * 1000); // Every 30 minutes

// Log refresh operation failures to error reporting system
function logOperationError(operationDetails, errorDetails) {
    const errorReport = {
        operationType: 'tab_refresh',
        timestamp: new Date().toISOString(),
        operationDetails,
        errorDetails,
        browserInfo: navigator.userAgent,
        extensionVersion: chrome.runtime.getManifest().version
    };
    
    reportError('operation_error', errorReport);
}

// Function to start refresh operation
function startRefreshOperation() {
    activeRefreshOperation = true;
    
    // Update icon to indicate operation is in progress
    chrome.action.setIcon({
        path: {
            "16": "assets/icon-refresh-em-colorful-16.png",
            "32": "assets/icon-refresh-em-colorful-32.png",
            "48": "assets/icon-refresh-em-colorful-48.png",
            "128": "assets/icon-refresh-em-colorful-128.png"
        }
    });
    
    // Update badge to show progress
    chrome.action.setBadgeBackgroundColor({ color: "#4285f4" });
    chrome.action.setBadgeText({ text: "0%" });
}

// Function to end refresh operation
function endRefreshOperation() {
    activeRefreshOperation = false;
    
    // Reset icon
    chrome.action.setIcon({
        path: {
            "16": "assets/icon-refresh-em-16.png",
            "32": "assets/icon-refresh-em-32.png",
            "48": "assets/icon-refresh-em-48.png",
            "128": "assets/icon-refresh-em-128.png"
        }
    });
    
    // Clear badge
    chrome.action.setBadgeText({ text: "" });
    
    // Log operation details including any errors
    const operationDetails = {
        startTime: startTime.toISOString(),
        endTime: new Date().toISOString(),
        totalTabs: tabsToRefresh.length,
        successfulTabs: refreshedTabs,
        failedCount: failedTabs.length
    };
    
    if (failedTabs.length > 0) {
        logOperationError(operationDetails, { failedTabs });
    }
    
    // Save operation to history
    saveToHistory({
        timestamp: startTime,
        totalTabs: tabsToRefresh.length,
        successfulTabs: refreshedTabs,
        failedTabs: failedTabs
    });
}

// Function to refresh tabs sequentially
function refreshTabsSequentially(tabs) {
    let currentIndex = 0;
    
    function refreshNextTab() {
        if (currentIndex >= tabs.length) {
            // All tabs have been processed
            endRefreshOperation();
            return;
        }
        
        const tab = tabs[currentIndex];
        
        refreshTab(tab)
            .then(() => {
                // Success
                refreshedTabs++;
            })
            .catch((error) => {
                // Error
                failedTabs.push({
                    tabId: tab.id,
                    title: tab.title || 'Unknown tab',
                    url: tab.url,
                    error: error.message || 'Unknown error'
                });
            })
            .finally(() => {
                // Update progress
                currentIndex++;
                updateProgress(currentIndex, tabs.length);
                
                // Process next tab with a small delay
                setTimeout(refreshNextTab, 100);
            });
    }
    
    // Start the sequence
    refreshNextTab();
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

// Function to update progress
function updateProgress(current, total) {
    const percentage = Math.min(100, Math.round((current / total) * 100));
    chrome.action.setBadgeText({ text: `${percentage}%` });
}

// Function to save operation to history
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
        chrome.storage.sync.set({ refreshHistory: history });
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

// Update function to send pending reports to return a promise
function attemptToSendPendingErrorReports() {
    return new Promise((resolve, reject) => {
        if (!ERROR_REPORTING_ENABLED) {
            resolve();
            return;
        }
        
        chrome.storage.sync.get(['errorReportingConsent'], (result) => {
            const hasConsent = result.errorReportingConsent === true;
            
            if (hasConsent) {
                chrome.storage.local.get(['pendingErrorReports'], (result) => {
                    const pendingReports = result.pendingErrorReports || [];
                    
                    if (pendingReports.length === 0) {
                        resolve();
                        return;
                    }
                    
                    // Try to send all pending reports
                    fetch(ERROR_REPORTING_ENDPOINT, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ reports: pendingReports })
                    })
                    .then(response => {
                        if (response.ok) {
                            // Clear sent reports if successful
                            chrome.storage.local.set({ pendingErrorReports: [] });
                            resolve();
                        } else {
                            reject();
                        }
                    })
                    .catch(() => {
                        reject();
                    });
                });
            } else {
                resolve();
            }
        });
    });
}
