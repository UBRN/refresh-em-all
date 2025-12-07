// State tracking
let activeRefreshOperation = false;
let tabsToRefresh = [];
let refreshedTabs = 0;
let failedTabs = [];
let startTime;
let operationCancelled = false;

// Constants for tab processing
const MAX_TABS_PER_BATCH = 5; // Process tabs in smaller batches
const TAB_PROCESSING_INTERVAL = 150; // ms between tab refreshes
const MAX_RETRIES = 2; // Number of retries for failed tab refreshes
const BATCH_INTERVAL = 500; // ms between batches

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
    if (activeRefreshOperation) {
        // If operation is already running, cancel it
        operationCancelled = true;
        return;
    }

    // Start refresh operation
    startRefreshOperation();

    chrome.tabs.query({}, (tabs) => {
        try {
            // Filter out invalid tabs
            tabsToRefresh = tabs.filter(tab => !!tab.id && tab.id !== chrome.tabs.TAB_ID_NONE);
            refreshedTabs = 0;
            failedTabs = [];
            startTime = new Date();
            operationCancelled = false;

            // Process tabs in batches for better performance
            refreshTabsInBatches(tabsToRefresh);
        } catch (error) {
            reportError('refresh_operation_start_error', {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            endRefreshOperation(false);
        }
    });
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startRefresh') {
        if (activeRefreshOperation) {
            sendResponse({ success: false, message: 'Operation already in progress' });
            return true;
        }

        startRefreshOperation();

        chrome.tabs.query({}, (tabs) => {
            try {
                // Filter out invalid tabs
                tabsToRefresh = tabs.filter(tab => !!tab.id && tab.id !== chrome.tabs.TAB_ID_NONE);
                refreshedTabs = 0;
                failedTabs = [];
                startTime = new Date();
                operationCancelled = false;

                // Process tabs in batches for better performance
                refreshTabsInBatches(tabsToRefresh);
                sendResponse({ success: true });
            } catch (error) {
                reportError('refresh_operation_start_error', {
                    message: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                endRefreshOperation(false);
            }
        });
        return true;
    }
    else if (message.action === 'reportError') {
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
    else if (message.action === 'getOperationStatus') {
        // Return current operation status
        sendResponse({
            active: activeRefreshOperation,
            progress: tabsToRefresh.length > 0 ? Math.round((refreshedTabs / tabsToRefresh.length) * 100) : 0,
            totalTabs: tabsToRefresh.length,
            refreshedTabs: refreshedTabs,
            failedTabs: failedTabs.length,
            currentTabs: tabsToRefresh // Optional: send info about tabs being processed if needed
        });
        return true;
    }
    else if (message.action === 'cancelOperation') {
        // Cancel the ongoing operation
        if (activeRefreshOperation) {
            operationCancelled = true;
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, message: 'No active operation to cancel' });
        }
        return true;
    }
});

// Function to report errors to the server
function reportError(errorType, errorDetails) {
    if (!ERROR_REPORTING_ENABLED) return;

    // Generate a UUID for this error
    const errorId = generateUuid();

    // Get user consent for error reporting from storage
    chrome.storage.sync.get(['errorReportingConsent'], (result) => {
        const hasConsent = result.errorReportingConsent === true;

        if (hasConsent) {
            // Add extension ID and browser info, but no personal identifiable information
            const reportData = {
                errorId,
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
                storeErrorForLaterReporting(errorType, { ...errorDetails, errorId });
            });
        } else {
            // Store error locally without reporting
            storeErrorForLaterReporting(errorType, { ...errorDetails, errorId });
        }
    });

    return errorId;
}

// Generate a UUID v4
function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
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
function endRefreshOperation(success = true) {
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
        startTime: startTime ? startTime.toISOString() : new Date().toISOString(),
        endTime: new Date().toISOString(),
        totalTabs: tabsToRefresh.length,
        successfulTabs: refreshedTabs,
        failedCount: failedTabs.length,
        cancelled: operationCancelled
    };

    if (failedTabs.length > 0) {
        logOperationError(operationDetails, {
            message: `Failed to refresh ${failedTabs.length} tab(s)`,
            tabs: failedTabs.map(tab => ({
                title: tab.title,
                url: tab.url,
                error: tab.error
            }))
        });
    }

    // Save the operation to history
    saveToHistory({
        timestamp: new Date().toISOString(),
        totalTabs: tabsToRefresh.length,
        successfulTabs: refreshedTabs,
        failedTabs: failedTabs.map(tab => ({
            title: tab.title || 'Unknown',
            url: tab.url || 'Unknown',
            error: tab.error || 'Unknown error'
        }))
    });

    // Broadcast completion to popup
    chrome.runtime.sendMessage({
        action: 'refreshComplete',
        success: success,
        details: operationDetails,
        failedTabs: failedTabs
    }).catch(() => {
        // Popup might be closed, ignore error
    });
}

// NEW: Process tabs in batches to avoid memory overload
function refreshTabsInBatches(tabs) {
    // Generate a unique operation ID for tracking
    const operationId = generateUuid();
    console.log(`Starting refresh operation ${operationId} with ${tabs.length} tabs`);

    // Reduce batch size for extremely large tab counts to prevent memory issues
    const dynamicBatchSize = tabs.length > 50 ? 3 : (tabs.length > 20 ? 4 : MAX_TABS_PER_BATCH);
    const dynamicBatchInterval = tabs.length > 50 ? 1000 : BATCH_INTERVAL; // Longer interval for more tabs

    let currentBatchIndex = 0;

    // Clear any previous timeout references if they exist
    if (window.batchTimeoutId) {
        clearTimeout(window.batchTimeoutId);
    }

    function processBatch() {
        if (operationCancelled) {
            console.log(`Operation ${operationId} cancelled at batch ${currentBatchIndex}`);
            endRefreshOperation(false);
            return;
        }

        const startIdx = currentBatchIndex * dynamicBatchSize;
        const endIdx = Math.min(startIdx + dynamicBatchSize, tabs.length);
        const currentBatch = tabs.slice(startIdx, endIdx);

        console.log(`Processing batch ${currentBatchIndex + 1}/${Math.ceil(tabs.length / dynamicBatchSize)}, tabs ${startIdx + 1}-${endIdx}`);

        // Process this batch
        refreshTabsBatch(currentBatch, 0, () => {
            currentBatchIndex++;
            updateProgress(refreshedTabs, tabs.length);

            // Memory management after each batch
            if (typeof gc === 'function') {
                try {
                    gc(); // Force garbage collection if available (will only work with appropriate Node.js flags)
                } catch (e) {
                    // Ignore if not available
                }
            }

            // If more batches to process, schedule the next one
            if (currentBatchIndex * dynamicBatchSize < tabs.length) {
                window.batchTimeoutId = setTimeout(processBatch, dynamicBatchInterval);
            } else {
                // All batches processed, end operation
                console.log(`Operation ${operationId} completed successfully`);
                endRefreshOperation(true);
                window.batchTimeoutId = null;
            }
        });
    }

    // Start processing the first batch
    processBatch();
}

// Process a single batch of tabs
function refreshTabsBatch(batch, tabIndex, onComplete) {
    if (operationCancelled) {
        onComplete();
        return;
    }

    if (tabIndex >= batch.length) {
        onComplete();
        return;
    }

    const tab = batch[tabIndex];

    refreshTab(tab, 0)
        .then(success => {
            if (success) {
                refreshedTabs++;
                // Notify popup of success
                chrome.runtime.sendMessage({
                    action: 'tabSucceeded',
                    tabId: tab.id
                }).catch(() => { });
            }

            // Process next tab in batch after a short delay
            setTimeout(() => {
                refreshTabsBatch(batch, tabIndex + 1, onComplete);
            }, TAB_PROCESSING_INTERVAL);
        })
        .catch(error => {
            // Log error and continue with next tab
            console.error(`Error refreshing tab ${tab.id}:`, error);
            failedTabs.push({
                ...tab,
                error: error.message || 'Unknown error'
            });

            // Notify popup of error
            chrome.runtime.sendMessage({
                action: 'tabFailed',
                tabId: tab.id,
                error: error.message || 'Unknown error'
            }).catch(() => { });

            setTimeout(() => {
                refreshTabsBatch(batch, tabIndex + 1, onComplete);
            }, TAB_PROCESSING_INTERVAL);
        });
}

// Add this function to help with debugging - it prevents Chrome from pausing execution
function disableDebuggerPause() {
    try {
        // This is executed in the browser's context to disable debugger functionality
        if (window.chrome && window.chrome.debugger) {
            // Attempt to disable any active debugging sessions
            const tabId = chrome.devtools && chrome.devtools.inspectedWindow ?
                chrome.devtools.inspectedWindow.tabId : null;

            if (tabId) {
                chrome.debugger.detach({ tabId }, () => {
                    if (chrome.runtime.lastError) {
                        // Ignore errors, this is just a best-effort attempt
                        console.log('Info: No active debugging sessions to detach');
                    }
                });
            }
        }

        // Override the debugger statement to prevent pausing
        // This helps avoid the "Paused in debugger" issue
        const originalDebugger = window.console.debug;
        window.console.debug = function () {
            // Simply log without triggering the debugger
            console.log.apply(console, arguments);
        };

        return true;
    } catch (error) {
        console.error('Error in disableDebuggerPause:', error);
        return false;
    }
}

// Inject this script into tabs that might have DevTools open to prevent pausing
function preventDebuggerPause(tabId) {
    try {
        chrome.scripting.executeScript({
            target: { tabId },
            function: disableDebuggerPause
        }).catch(() => {
            // Ignore errors - this is just a best-effort attempt
        });
    } catch (error) {
        // Ignore errors - some tabs may not allow script injection
    }
}

// Modified refreshTab function to include debugger prevention
async function refreshTab(tab, retryCount = 0) {
    if (!tab || !tab.id || tab.id === chrome.tabs.TAB_ID_NONE) {
        return false;
    }

    try {
        // Skip browser UI tabs that can't be refreshed
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') ||
            tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://'))) {
            return true; // Count as success but skip refresh
        }

        // Try to prevent debugger pausing
        preventDebuggerPause(tab.id);

        // Check if tab still exists
        return new Promise((resolve) => {
            chrome.tabs.get(tab.id, async (tabInfo) => {
                if (chrome.runtime.lastError || !tabInfo) {
                    // Tab doesn't exist anymore
                    resolve(true); // Count as success since we can't refresh it
                    return;
                }

                // Check if tab is loading - if so, wait before refreshing
                if (tabInfo.status === 'loading') {
                    setTimeout(() => {
                        refreshTab(tab, retryCount).then(resolve);
                    }, 500);
                    return;
                }

                if (tabInfo.discarded) {
                    // Handle discarded tabs with more care
                    try {
                        await activateAndRefreshTab(tab, retryCount, resolve);
                    } catch (error) {
                        handleTabRefreshError(tab, error, retryCount, resolve);
                    }
                } else {
                    // Handle normal (non-discarded) tab
                    try {
                        await preserveStateAndRefreshTab(tab, retryCount, resolve);
                    } catch (error) {
                        handleTabRefreshError(tab, error, retryCount, resolve);
                    }
                }
            });
        });
    } catch (error) {
        return await handleRefreshError(tab, error, retryCount);
    }
}

// Helper function to activate and refresh a discarded tab
async function activateAndRefreshTab(tab, retryCount, resolve) {
    return new Promise((resolveFn) => {
        // Make the tab active first
        chrome.tabs.update(tab.id, { active: true }, () => {
            if (chrome.runtime.lastError) {
                if (retryCount < MAX_RETRIES) {
                    // Retry with backoff
                    setTimeout(() => {
                        refreshTab(tab, retryCount + 1).then(resolve);
                    }, 500 * (retryCount + 1));
                    return;
                } else {
                    failedTabs.push({
                        ...tab,
                        error: chrome.runtime.lastError.message || 'Failed to activate tab'
                    });
                    resolve(false);
                    return;
                }
            }

            // Now reload it after a short delay to ensure tab is ready
            setTimeout(() => {
                chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                    if (chrome.runtime.lastError) {
                        if (retryCount < MAX_RETRIES) {
                            // Retry with backoff
                            setTimeout(() => {
                                refreshTab(tab, retryCount + 1).then(resolve);
                            }, 500 * (retryCount + 1));
                        } else {
                            failedTabs.push({
                                ...tab,
                                error: chrome.runtime.lastError.message || 'Failed to reload tab'
                            });
                            resolve(false);
                        }
                    } else {
                        resolve(true);
                        resolveFn();
                    }
                });
            }, 500); // Increased delay for better stability
        });
    });
}

// Helper function to preserve state and refresh a normal tab
async function preserveStateAndRefreshTab(tab, retryCount, resolve) {
    return new Promise((resolveFn) => {
        // Try to save media state before refreshing, but handle errors gracefully
        try {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                function: preserveMediaState
            }, (results) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    // If we can't inject script, just reload without preserving state
                    basicReload(tab, retryCount, resolve);
                } else {
                    // Script executed successfully, now reload the tab
                    setTimeout(() => {
                        chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                            if (chrome.runtime.lastError) {
                                if (retryCount < MAX_RETRIES) {
                                    // Retry with backoff
                                    setTimeout(() => {
                                        refreshTab(tab, retryCount + 1).then(resolve);
                                    }, 500 * (retryCount + 1));
                                } else {
                                    failedTabs.push({
                                        ...tab,
                                        error: chrome.runtime.lastError.message || 'Failed to reload tab'
                                    });
                                    resolve(false);
                                }
                            } else {
                                resolve(true);
                                resolveFn();
                            }
                        });
                    }, 100);
                }
            });
        } catch (error) {
            // Fallback to basic reload if script execution throws an error
            basicReload(tab, retryCount, resolve);
        }
    });
}

// Basic reload without trying to preserve state
function basicReload(tab, retryCount, resolve) {
    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
        if (chrome.runtime.lastError) {
            if (retryCount < MAX_RETRIES) {
                // Retry with backoff
                setTimeout(() => {
                    refreshTab(tab, retryCount + 1).then(resolve);
                }, 500 * (retryCount + 1));
            } else {
                failedTabs.push({
                    ...tab,
                    error: chrome.runtime.lastError.message || 'Failed to reload tab'
                });
                resolve(false);
            }
        } else {
            resolve(true);
        }
    });
}

// Helper to handle refresh errors
async function handleRefreshError(tab, error, retryCount) {
    console.error(`Error refreshing tab ${tab.id}:`, error);

    if (retryCount < MAX_RETRIES) {
        // Retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
        return refreshTab(tab, retryCount + 1);
    }

    failedTabs.push({
        ...tab,
        error: error.message || 'Unknown error'
    });
    return false;
}

// Helper to handle tab refresh errors
function handleTabRefreshError(tab, error, retryCount, resolve) {
    console.error(`Error refreshing tab ${tab.id}:`, error);

    if (retryCount < MAX_RETRIES) {
        // Retry with exponential backoff
        setTimeout(() => {
            refreshTab(tab, retryCount + 1).then(resolve);
        }, 500 * Math.pow(2, retryCount));
    } else {
        failedTabs.push({
            ...tab,
            error: error.message || 'Unknown error during refresh'
        });
        resolve(false);
    }
}

// Function to update progress
function updateProgress(current, total) {
    if (!activeRefreshOperation) return;

    const percent = Math.floor((current / total) * 100);
    chrome.action.setBadgeText({ text: percent + "%" });

    // Broadcast progress to popup
    chrome.runtime.sendMessage({
        action: 'refreshProgress',
        current,
        total,
        percent,
        failed: failedTabs.length
    }).catch(() => {
        // Popup might be closed, ignore error
    });
}

// Function to save operation to history
function saveToHistory(operation) {
    chrome.storage.sync.get(['refreshHistory'], (result) => {
        const history = result.refreshHistory || [];

        // Add newest operation at the beginning
        history.unshift(operation);

        // Limit history to 20 entries
        if (history.length > 20) {
            history.pop();
        }

        chrome.storage.sync.set({ refreshHistory: history });
    });
}

// Function to preserve media state before refresh
function preserveMediaState() {
    try {
        const videos = document.querySelectorAll('video');
        const audios = document.querySelectorAll('audio');
        let mediaStates = {};

        // Store video states - with special handling for YouTube
        videos.forEach((video, index) => {
            // Check if the video element is visible and has dimensions
            const isVisible = video.offsetWidth > 0 && video.offsetHeight > 0;
            const isYouTube = window.location.hostname.includes('youtube.com');

            mediaStates[`video_${index}`] = {
                src: video.src || (isYouTube ? 'youtube_video' : 'video_element'),
                currentTime: video.currentTime,
                paused: video.paused,
                muted: video.muted,
                volume: video.volume,
                playbackRate: video.playbackRate,
                isYouTube: isYouTube,
                url: window.location.href,
                isVisible: isVisible
            };
        });

        // Store audio states
        audios.forEach((audio, index) => {
            // Capture audio state even if src is empty
            mediaStates[`audio_${index}`] = {
                src: audio.src || 'audio_element',
                currentTime: audio.currentTime,
                paused: audio.paused,
                muted: audio.muted,
                volume: audio.volume,
                playbackRate: audio.playbackRate
            };
        });

        // Enhanced YouTube-specific handling
        if (window.location.hostname.includes('youtube.com')) {
            const player = document.querySelector('.html5-video-player');
            mediaStates['youtube_player_state'] = {
                url: window.location.href,
                paused: player ? (
                    player.classList.contains('paused-mode') ||
                    !player.classList.contains('playing-mode')
                ) : true,
                // Store additional attributes to better identify the YouTube player state
                videoId: new URLSearchParams(window.location.search).get('v') ||
                    window.location.pathname.split('/').pop(),
                timestamp: Math.floor(Date.now() / 1000)
            };
        }

        // Save to sessionStorage if we have media elements
        if (Object.keys(mediaStates).length > 0) {
            sessionStorage.setItem('refreshEmAllMediaState', JSON.stringify(mediaStates));
            return { success: true, count: Object.keys(mediaStates).length };
        }

        return { success: true, count: 0 };
    } catch (error) {
        console.error("Error preserving media state:", error);
        return { success: false, error: error.message };
    }
}

// Attempt to send pending error reports
async function attemptToSendPendingErrorReports() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['pendingErrorReports'], (result) => {
            const pendingReports = result.pendingErrorReports || [];

            if (pendingReports.length === 0) {
                resolve({ sent: 0 });
                return;
            }

            // Check user consent
            chrome.storage.sync.get(['errorReportingConsent'], (consentResult) => {
                const hasConsent = consentResult.errorReportingConsent === true;

                if (!hasConsent) {
                    resolve({ sent: 0, reason: 'no-consent' });
                    return;
                }

                // Send reports in batches
                const batch = pendingReports.slice(0, 10);
                const promises = batch.map(report =>
                    fetch(ERROR_REPORTING_ENDPOINT, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            ...report,
                            extensionId: chrome.runtime.id,
                            reportedAt: new Date().toISOString()
                        })
                    }).then(response => response.ok)
                );

                Promise.allSettled(promises).then(results => {
                    // Count successful sends
                    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;

                    // Remove successful reports
                    const newPendingReports = [
                        ...pendingReports.slice(successCount)
                    ];

                    chrome.storage.local.set({ pendingErrorReports: newPendingReports }, () => {
                        resolve({
                            sent: successCount,
                            remaining: newPendingReports.length
                        });
                    });
                }).catch(error => {
                    reject(error);
                });
            });
        });
    });
}
