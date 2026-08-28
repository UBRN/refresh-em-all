function t(key, ...substitutions) {
    return chrome.i18n.getMessage(
        key,
        substitutions.length > 0 ? substitutions.map(String) : undefined
    );
}

// State tracking
let activeRefreshOperation = false;
let tabsToRefresh = [];
let refreshedTabs = 0;
let processedTabs = 0;
let failedTabs = [];
let skippedTabs = [];
let tabStatuses = {};
let startTime;
let operationCancelled = false;
let operationFinalized = false;
// Every refresh operation gets a generation number. Async work captures the
// generation it was started for and checks it before touching shared state, so
// a timer or callback left over from a cancelled or finished run cannot mutate
// the run that replaced it.
let currentGeneration = 0;
let operationResumeCount = 0;
// Finalization does a read-modify-write of cacheStats and refreshHistory. Two runs
// can finalize close together (a cancel followed straight away by a new refresh),
// so they queue instead of interleaving.
let finalizeQueue = Promise.resolve();
let batchTimeoutId = null;
let staleBytesThisRun = 0;
let hasSiteAccess = false;

// Tabs this worker just reloaded that are still waiting for media restoration.
// ponytail: in-memory only, if the MV3 worker is evicted between the reload
// and the tab reaching "complete", that tab's restore is skipped. Move to
// chrome.storage.session if that gap shows up in practice.
const pendingMediaRestores = new Map(); // tabId -> timeout id
const MEDIA_RESTORE_TIMEOUT_MS = 30000;

// Constants for tab processing
const MAX_TABS_PER_BATCH = 5; // Process tabs in smaller batches
const TAB_PROCESSING_INTERVAL = 75; // ms between tab refreshes
const MAX_RETRIES = 2; // Number of retries for failed tab refreshes
const BATCH_INTERVAL = 250; // ms between batches
const MAX_LOADING_WAIT_MS = 10000;
const MAX_TAB_REFRESH_MS = 30000;
// A refresh that outlives its service worker resumes from the persisted cursor.
// The cap stops a worker that keeps dying before it makes progress from
// reloading the same tabs forever.
const MAX_OPERATION_RESUMES = 3;

function isStaleGeneration(generation) {
    return generation !== currentGeneration || operationFinalized;
}

function clearPendingMediaRestore(tabId) {
    const timeoutId = pendingMediaRestores.get(tabId);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    pendingMediaRestores.delete(tabId);
}

function scheduleMediaRestore(tabId) {
    clearPendingMediaRestore(tabId);
    pendingMediaRestores.set(
        tabId,
        setTimeout(() => pendingMediaRestores.delete(tabId), MEDIA_RESTORE_TIMEOUT_MS)
    );
}

function restoreMediaStateInTab(tabId) {
    try {
        chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-script.js']
        }, () => {
            // The tab may have navigated away, closed, or be restricted by now.
            void chrome.runtime.lastError;
        });
    } catch (error) {
        console.debug('[Refresh Em All] Media restoration injection failed:', error);
    }
}

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    if (!pendingMediaRestores.has(tabId)) return;

    clearPendingMediaRestore(tabId);
    restoreMediaStateInTab(tabId);
});

chrome.tabs.onRemoved.addListener(clearPendingMediaRestore);

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startRefresh') {
        if (activeRefreshOperation) {
            sendResponse({ success: false, message: t('errorOperationInProgress') });
            return true;
        }

        startRefreshOperation();
        const generation = currentGeneration;

        chrome.tabs.query({}, (tabs) => {
            initializeAndStartRefresh(tabs, sendResponse, generation).catch(error => {
                reportError('refresh_operation_start_error', {
                    message: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                endRefreshOperation(false, generation);
            });
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
        sendResponse({ success: false, message: 'Error reporting is disabled' });
        return true;
    }
    else if (message.action === 'getOperationStatus') {
        if (activeRefreshOperation) {
            sendResponse(getOperationSnapshot());
            return true;
        }

        if (chrome.storage.session) {
            chrome.storage.session.get(['refreshOperationState'], (result) => {
                const storedState = result.refreshOperationState;
                sendResponse(storedState
                    ? normalizeStoredOperation(storedState)
                    : getOperationSnapshot());
            });
            return true;
        }

        sendResponse(getOperationSnapshot());
        return true;
    }
    else if (message.action === 'cancelOperation') {
        // Cancel the ongoing operation
        if (activeRefreshOperation) {
            operationCancelled = true;
            if (batchTimeoutId) {
                clearTimeout(batchTimeoutId);
                batchTimeoutId = null;
            }
            endRefreshOperation(false, currentGeneration);
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, message: 'No active operation to cancel' });
        }
        return true;
    }
});

function getOperationSnapshot() {
    const totalTabs = tabsToRefresh.length;
    return {
        active: activeRefreshOperation,
        generation: currentGeneration,
        interrupted: false,
        progress: totalTabs > 0 ? Math.round((processedTabs / totalTabs) * 100) : 0,
        totalTabs,
        processedTabs,
        refreshedTabs,
        failedTabs: failedTabs.length,
        failedTabDetails: failedTabs,
        skippedTabs: skippedTabs.length,
        skippedTabIds: skippedTabs,
        currentTabs: tabsToRefresh,
        tabStatuses,
        cancelled: operationCancelled,
        startTime: startTime ? startTime.toISOString() : null,
        resumeCount: operationResumeCount,
        staleBytes: staleBytesThisRun,
        lastUpdated: new Date().toISOString()
    };
}

function persistOperationState() {
    if (!chrome.storage.session) return;
    chrome.storage.session.set({ refreshOperationState: getOperationSnapshot() }, () => {
        void chrome.runtime.lastError;
    });
}

function clearPersistedOperationState() {
    if (!chrome.storage.session) return;
    chrome.storage.session.remove(['refreshOperationState'], () => {
        void chrome.runtime.lastError;
    });
}

// A stored record is only as trustworthy as whatever wrote it. Keep the shapes the
// rest of the worker and the popup assume, and drop anything else.
function normalizeStoredOperation(stored) {
    return {
        ...stored,
        currentTabs: Array.isArray(stored.currentTabs) ? stored.currentTabs : [],
        tabStatuses: stored.tabStatuses
            && typeof stored.tabStatuses === 'object'
            && !Array.isArray(stored.tabStatuses)
            ? stored.tabStatuses
            : {},
        failedTabDetails: Array.isArray(stored.failedTabDetails) ? stored.failedTabDetails : []
    };
}

function isTabRecord(value) {
    return value !== null && typeof value === 'object' && Number.isInteger(value.id);
}

function restoreInterruptedOperation() {
    if (!chrome.storage.session || activeRefreshOperation) return;

    chrome.storage.session.get(['refreshOperationState'], async (result) => {
        if (chrome.runtime.lastError) return;

        const stored = result.refreshOperationState;
        if (!stored || stored.active !== true) return;
        if (activeRefreshOperation) return;

        const normalized = normalizeStoredOperation(stored);
        tabsToRefresh = normalized.currentTabs.filter(isTabRecord);
        processedTabs = Number.isFinite(stored.processedTabs) ? stored.processedTabs : 0;
        refreshedTabs = Number.isFinite(stored.refreshedTabs) ? stored.refreshedTabs : 0;
        failedTabs = normalized.failedTabDetails.filter(isTabRecord);
        skippedTabs = Array.isArray(stored.skippedTabIds)
            ? stored.skippedTabIds.filter(Number.isInteger)
            : [];
        tabStatuses = stored.tabStatuses
            && typeof stored.tabStatuses === 'object'
            && !Array.isArray(stored.tabStatuses)
            ? stored.tabStatuses
            : {};
        staleBytesThisRun = Number.isFinite(stored.staleBytes) ? stored.staleBytes : 0;
        const restoredStartTime = new Date(stored.startTime);
        startTime = stored.startTime && !Number.isNaN(restoredStartTime.getTime())
            ? restoredStartTime
            : new Date();
        const storedResumeCount = Number.isFinite(stored.resumeCount) ? stored.resumeCount : 0;

        if (
            stored.cancelled === true
            || processedTabs >= tabsToRefresh.length
            || storedResumeCount >= MAX_OPERATION_RESUMES
        ) {
            // Tab records are dropped on purpose: the popup only reports progress
            // for an interrupted run, so there is no reason to keep URLs or titles
            // in session storage after the run is abandoned.
            const totalTabs = tabsToRefresh.length;
            const interruptedState = {
                active: false,
                interrupted: true,
                progress: totalTabs > 0 ? Math.round((processedTabs / totalTabs) * 100) : 0,
                totalTabs,
                processedTabs,
                refreshedTabs,
                failedTabs: failedTabs.length,
                skippedTabs: skippedTabs.length,
                cancelled: stored.cancelled === true,
                lastUpdated: new Date().toISOString()
            };
            activeRefreshOperation = true;
            operationFinalized = false;
            currentGeneration++;
            endRefreshOperation(false, currentGeneration);
            // endRefreshOperation dispatches the clear first. Write the interrupted
            // record afterward so it survives for the popup to report.
            chrome.storage.session.set({ refreshOperationState: interruptedState }, () => {
                void chrome.runtime.lastError;
            });
            operationResumeCount = 0;
            return;
        }

        // Claim the operation before awaiting anything, otherwise a cancel arriving
        // during the permission lookup is refused as "no active operation" and the
        // resume below reloads a run the user already stopped.
        operationResumeCount = storedResumeCount + 1;
        startRefreshOperation();
        const generation = currentGeneration;

        try {
            hasSiteAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] }) === true;
        } catch (error) {
            hasSiteAccess = false;
        }

        if (isStaleGeneration(generation)) return;

        // The cursor write is asynchronous, so an eviction can reload at most one
        // tab twice. Reloading the same tab twice is harmless.
        persistOperationState();
        refreshTabsInBatches(tabsToRefresh.slice(processedTabs), generation);
    });
}

// Prepare and start the refresh operation once tabs are available
async function initializeAndStartRefresh(tabs, sendResponse, generation) {
    // The tabs.query callback can land after this run was cancelled and another
    // one took its place. Claiming the shared state now would reset that run.
    if (isStaleGeneration(generation)) {
        if (typeof sendResponse === 'function') sendResponse({ success: false });
        return;
    }

    if (chrome.runtime.lastError) {
        handleRefreshStartFailure(chrome.runtime.lastError.message, sendResponse, generation);
        return;
    }

    if (!Array.isArray(tabs) || tabs.length === 0) {
        handleRefreshStartFailure(t('errorNoTabs'), sendResponse, generation);
        return;
    }

    // Filter out invalid tabs
    tabsToRefresh = tabs.filter(tab => Number.isInteger(tab.id) && tab.id !== chrome.tabs.TAB_ID_NONE);

    if (tabsToRefresh.length === 0) {
        handleRefreshStartFailure(t('errorNoRefreshableTabs'), sendResponse, generation);
        return;
    }

    try {
        hasSiteAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] }) === true;
    } catch (error) {
        hasSiteAccess = false;
    }

    // The permission lookup is another await boundary the run can be replaced across.
    if (isStaleGeneration(generation)) {
        if (typeof sendResponse === 'function') sendResponse({ success: false });
        return;
    }

    refreshedTabs = 0;
    processedTabs = 0;
    staleBytesThisRun = 0;
    // A resumed run raises this counter. A manual run starts its own budget.
    operationResumeCount = 0;
    failedTabs = [];
    skippedTabs = [];
    tabStatuses = Object.fromEntries(tabsToRefresh.map(tab => [tab.id, 'pending']));
    startTime = new Date();
    operationFinalized = false;
    persistOperationState();

    // Let the popup initialize its UI with the tab list
    chrome.runtime.sendMessage({
        action: 'refreshStarted',
        generation,
        tabs: tabsToRefresh
    }).catch(() => {
        // Popup might be closed
    });

    // Process tabs in batches for better performance
    refreshTabsInBatches(tabsToRefresh, generation);

    if (typeof sendResponse === 'function') {
        sendResponse({ success: true });
    }
}

function handleRefreshStartFailure(message, sendResponse, generation) {
    const errorMessage = message || t('errorStartGeneric');

    tabsToRefresh = [];
    refreshedTabs = 0;
    processedTabs = 0;
    skippedTabs = [];
    tabStatuses = {};
    failedTabs = [{
        title: t('errorStartFailureTabTitle'),
        url: 'N/A',
        error: errorMessage
    }];
    startTime = new Date();

    reportError('refresh_operation_start_error', {
        message: errorMessage,
        timestamp: new Date().toISOString()
    });

    if (typeof sendResponse === 'function') {
        sendResponse({ success: false, message: errorMessage });
    }

    endRefreshOperation(false, generation);
}

// Error reporting is intentionally local-only until a real, privacy-reviewed
// reporting service and disclosure are available.
function reportError(errorType, errorDetails) {
    const message = errorDetails && errorDetails.message
        ? errorDetails.message
        : 'Unexpected extension error';
    console.error(`[Refresh Em All] ${errorType}: ${message}`);
    return null;
}

// Remove legacy telemetry data and move history out of Chrome Sync.
chrome.storage.local.remove(['pendingErrorReports']);
migrateHistoryToLocalStorage();
restoreInterruptedOperation();

function migrateHistoryToLocalStorage() {
    chrome.storage.sync.get(['refreshHistory', 'errorReportingConsent'], (syncResult) => {
        const oldHistory = Array.isArray(syncResult.refreshHistory)
            ? syncResult.refreshHistory
            : [];

        chrome.storage.local.get(['refreshHistory'], (localResult) => {
            if (!Array.isArray(localResult.refreshHistory) && oldHistory.length > 0) {
                const sanitizedHistory = oldHistory.slice(0, 10).map(item => ({
                    timestamp: item.timestamp,
                    totalTabs: Number(item.totalTabs) || 0,
                    successfulTabs: Number(item.successfulTabs) || 0,
                    failedCount: Array.isArray(item.failedTabs)
                        ? item.failedTabs.length
                        : (Number(item.failedCount) || 0),
                    skippedCount: Number(item.skippedCount) || 0,
                    cancelled: item.cancelled === true
                }));
                chrome.storage.local.set({ refreshHistory: sanitizedHistory });
            }

            chrome.storage.sync.remove(['refreshHistory', 'errorReportingConsent']);
        });
    });
}

// Function to start refresh operation
function startRefreshOperation() {
    currentGeneration++;
    activeRefreshOperation = true;
    operationFinalized = false;
    operationCancelled = false;

    // No icon swap here: these are the same colorful icons the manifest already
    // declares as action.default_icon, so setting them changed nothing. The badge
    // below is what actually signals that a refresh is running.

    // Update badge to show progress
    chrome.action.setBadgeBackgroundColor({ color: "#4285f4" });
    chrome.action.setBadgeText({ text: "0%" });
}

// Function to end refresh operation
function endRefreshOperation(success = true, generation) {
    if (generation !== currentGeneration || operationFinalized) return;
    operationFinalized = true;
    activeRefreshOperation = false;
    const finalSuccess = success && !operationCancelled && failedTabs.length === 0;

    // Restore the colorful action icons the manifest declares. Earlier versions
    // "reset" to the monochrome assets/icon-refresh-em-*.png set instead, which are
    // the extension-management icons, not the toolbar ones, so the first completed
    // refresh turned the toolbar icon grey and Chrome kept that override.
    // ponytail: this exists only to repair that stored override; drop it once no
    // install predating the fix is left.
    chrome.action.setIcon({
        path: {
            "16": "assets/icon-refresh-em-colorful-16.png",
            "32": "assets/icon-refresh-em-colorful-32.png",
            "48": "assets/icon-refresh-em-colorful-48.png",
            "128": "assets/icon-refresh-em-colorful-128.png"
        }
    });

    // Clear badge
    chrome.action.setBadgeText({ text: "" });

    // Log operation details including any errors
    const operationDetails = {
        startTime: startTime ? startTime.toISOString() : new Date().toISOString(),
        endTime: new Date().toISOString(),
        totalTabs: tabsToRefresh.length,
        processedTabs,
        successfulTabs: refreshedTabs,
        failedCount: failedTabs.length,
        skippedCount: skippedTabs.length,
        cancelled: operationCancelled,
        staleBytes: staleBytesThisRun
    };

    const historyEntry = {
        timestamp: new Date().toISOString(),
        totalTabs: tabsToRefresh.length,
        successfulTabs: refreshedTabs,
        failedCount: failedTabs.length,
        skippedCount: skippedTabs.length,
        cancelled: operationCancelled
    };

    // Everything below runs inside storage callbacks, by which point a refresh
    // started right after this one may already have reset the shared state.
    // Snapshot what those callbacks need instead of reading it live.
    const finalStaleBytes = staleBytesThisRun;
    const finalFailedTabs = failedTabs;

    clearPersistedOperationState();
    // Queued rather than fired straight away: cacheStats and refreshHistory are
    // read-modify-write, and a cancel followed by a new refresh can otherwise have
    // two finalizations interleave and lose one run's bytes or history entry.
    finalizeQueue = finalizeQueue.then(() => new Promise(resolveFinalize => {
      chrome.storage.local.get(['cacheStats'], (result) => {
        const previous = result.cacheStats
            && typeof result.cacheStats === 'object'
            && !Array.isArray(result.cacheStats)
            ? result.cacheStats
            : {};
        const previousDays = previous.days
            && typeof previous.days === 'object'
            && !Array.isArray(previous.days)
            ? previous.days
            : {};
        const today = dayKey();
        const days = {
            ...previousDays,
            [today]: (Number.isFinite(previousDays[today]) ? previousDays[today] : 0) + finalStaleBytes
        };
        const prunedDays = Object.fromEntries(
            Object.keys(days).sort().slice(-31).map(key => [key, days[key]])
        );
        const next = {
            lastRun: finalStaleBytes,
            total: (Number.isFinite(previous.total) ? previous.total : 0) + finalStaleBytes,
            days: prunedDays
        };

        chrome.storage.local.set({ cacheStats: next }, () => {
            saveToHistory(historyEntry, () => {
                // Broadcast completion after history is durable so an open popup can reload it.
                chrome.runtime.sendMessage({
                    action: 'refreshComplete',
                    generation,
                    success: finalSuccess,
                    details: operationDetails,
                    failedTabs: finalFailedTabs
                }).catch(() => {
                    // Popup might be closed, ignore error
                });
                resolveFinalize();
            });
        });
      });
    }));
}

// NEW: Process tabs in batches to avoid memory overload
function refreshTabsInBatches(tabs, generation) {
    console.log(`Starting refresh operation ${generation} with ${tabs.length} tabs`);

    // Reduce batch size for extremely large tab counts to prevent memory issues
    const dynamicBatchSize = tabs.length > 50 ? 3 : (tabs.length > 20 ? 4 : MAX_TABS_PER_BATCH);
    const dynamicBatchInterval = tabs.length > 50 ? 1000 : BATCH_INTERVAL; // Longer interval for more tabs

    let currentBatchIndex = 0;

    // Clear any previous timeout references if they exist
    if (batchTimeoutId) {
        clearTimeout(batchTimeoutId);
    }

    function processBatch() {
        if (isStaleGeneration(generation)) return;

        if (operationCancelled) {
            console.log(`Operation ${generation} cancelled at batch ${currentBatchIndex}`);
            endRefreshOperation(false, generation);
            return;
        }

        const startIdx = currentBatchIndex * dynamicBatchSize;
        const endIdx = Math.min(startIdx + dynamicBatchSize, tabs.length);
        const currentBatch = tabs.slice(startIdx, endIdx);

        console.log(`Processing batch ${currentBatchIndex + 1}/${Math.ceil(tabs.length / dynamicBatchSize)}, tabs ${startIdx + 1}-${endIdx}`);

        // Process this batch
        refreshTabsBatch(currentBatch, 0, () => {
            if (isStaleGeneration(generation)) return;

            if (operationCancelled) {
                console.log(`Operation ${generation} cancelled at batch ${currentBatchIndex}`);
                endRefreshOperation(false, generation);
                batchTimeoutId = null;
                return;
            }

            currentBatchIndex++;

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
                batchTimeoutId = setTimeout(processBatch, dynamicBatchInterval);
            } else {
                // All batches processed, end operation
                console.log(`Operation ${generation} completed`);
                endRefreshOperation(true, generation);
                batchTimeoutId = null;
            }
        }, generation);
    }

    // Start processing the first batch
    processBatch();
}

// Process a single batch of tabs
function refreshTabsBatch(batch, tabIndex, onComplete, generation) {
    if (isStaleGeneration(generation)) {
        onComplete();
        return;
    }

    if (operationCancelled) {
        onComplete();
        return;
    }

    if (tabIndex >= batch.length) {
        onComplete();
        return;
    }

    const tab = batch[tabIndex];

    refreshTabWithTimeout(tab, generation)
        .then(result => {
            if (isStaleGeneration(generation)) return;

            processedTabs++;

            if (result === true) {
                refreshedTabs++;
                tabStatuses[tab.id] = 'success';
                chrome.runtime.sendMessage({
                    action: 'tabSucceeded',
                    tabId: tab.id
                }).catch(() => { });
            } else if (result === 'skipped') {
                skippedTabs.push(tab.id);
                tabStatuses[tab.id] = 'skipped';
                chrome.runtime.sendMessage({
                    action: 'tabSkipped',
                    tabId: tab.id
                }).catch(() => { });
            } else {
                const failure = failedTabs.find(item => item.id === tab.id);
                const errorMessage = failure?.error || t('errorTabRefreshFailed');
                tabStatuses[tab.id] = 'error';
                chrome.runtime.sendMessage({
                    action: 'tabFailed',
                    tabId: tab.id,
                    error: errorMessage
                }).catch(() => { });
            }

            persistOperationState();
            updateProgress(processedTabs, tabsToRefresh.length, generation);

            // Process next tab in batch after a short delay
            setTimeout(() => {
                refreshTabsBatch(batch, tabIndex + 1, onComplete, generation);
            }, TAB_PROCESSING_INTERVAL);
        })
        .catch(error => {
            if (isStaleGeneration(generation)) return;

            // Log error and continue with next tab
            console.error(`Error refreshing tab ${tab.id}:`, error);
            const failure = recordTabFailure(tab, error.message || t('errorUnknown'), generation);
            processedTabs++;
            tabStatuses[tab.id] = 'error';

            // Notify popup of error
            chrome.runtime.sendMessage({
                action: 'tabFailed',
                tabId: tab.id,
                error: failure.error
            }).catch(() => { });

            persistOperationState();
            updateProgress(processedTabs, tabsToRefresh.length, generation);

            setTimeout(() => {
                refreshTabsBatch(batch, tabIndex + 1, onComplete, generation);
            }, TAB_PROCESSING_INTERVAL);
        });
}

function refreshTabWithTimeout(tab, generation) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(t('errorRefreshTimeout', MAX_TAB_REFRESH_MS / 1000)));
        }, MAX_TAB_REFRESH_MS);

        refreshTab(tab, 0, undefined, generation)
            .then(result => {
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

function recordTabFailure(tab, error, generation) {
    const failure = {
        ...tab,
        error: error || t('errorUnknown')
    };
    if (isStaleGeneration(generation)) return failure;

    const existingFailure = failedTabs.find(item => item.id === tab.id);
    if (existingFailure) return existingFailure;

    failedTabs.push(failure);
    return failure;
}

async function refreshTab(tab, retryCount = 0, loadingWaitStartedAt = Date.now(), generation) {
    if (!tab || !Number.isInteger(tab.id) || tab.id === chrome.tabs.TAB_ID_NONE) {
        return 'skipped';
    }

    try {
        // Check if tab still exists
        return new Promise((resolve) => {
            chrome.tabs.get(tab.id, (tabInfo) => {
                if (isStaleGeneration(generation)) {
                    resolve('skipped');
                    return;
                }

                if (chrome.runtime.lastError || !tabInfo) {
                    // Tab doesn't exist anymore
                    resolve('skipped');
                    return;
                }

                // Skip browser UI tabs that can't be refreshed
                if (isRestrictedTabUrl(tabInfo.url)) {
                    resolve('skipped');
                    return;
                }

                // Give already-loading tabs a bounded chance to settle.
                if (tabInfo.status === 'loading' && Date.now() - loadingWaitStartedAt < MAX_LOADING_WAIT_MS) {
                    setTimeout(() => {
                        if (isStaleGeneration(generation)) { resolve('skipped'); return; }
                        refreshTab(tab, retryCount, loadingWaitStartedAt, generation).then(resolve);
                    }, 500);
                    return;
                }

                if (tabInfo.discarded || !hasSiteAccess) {
                    // Discarded tabs reload without changing the user's active tab, and
                    // have no live media to capture. Without site access the capture
                    // injection would be rejected for every tab, so skip straight past it.
                    basicReload(tab, retryCount, resolve, generation);
                } else {
                    // Handle normal (non-discarded) tab
                    try {
                        preserveStateAndRefreshTab(tab, retryCount, resolve, generation);
                    } catch (error) {
                        handleTabRefreshError(tab, error, retryCount, resolve, generation);
                    }
                }
            });
        });
    } catch (error) {
        return await handleRefreshError(tab, error, retryCount, generation);
    }
}

function isRestrictedTabUrl(url) {
    if (!url) return false;

    return [
        'about:',
        'chrome:',
        'chrome-extension:',
        'chrome-search:',
        'chrome-untrusted:',
        'devtools:',
        'edge:'
    ].some(protocol => url.startsWith(protocol));
}

// Helper function to preserve state and refresh a normal tab
function preserveStateAndRefreshTab(tab, retryCount, resolve, generation) {
    // Try to save media state before refreshing, but handle errors gracefully.
    try {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: preserveMediaState
        }, (injectionResults) => {
            if (isStaleGeneration(generation)) {
                resolve('skipped');
                return;
            }

            const error = chrome.runtime.lastError;
            if (error) {
                basicReload(tab, retryCount, resolve, generation);
                return;
            }

            const measuredStaleBytes = injectionResults?.[0]?.result?.staleBytes;
            if (!isStaleGeneration(generation) && Number.isFinite(measuredStaleBytes)) {
                staleBytesThisRun += measuredStaleBytes;
            }
            const capturedCount = injectionResults?.[0]?.result?.count;
            // Unexpected or absent results restore rather than silently dropping captured state.
            const hasStateToRestore = capturedCount !== 0;

            chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                if (chrome.runtime.lastError) {
                    if (retryCount < MAX_RETRIES) {
                        setTimeout(() => {
                            if (isStaleGeneration(generation)) { resolve('skipped'); return; }
                            refreshTab(tab, retryCount + 1, undefined, generation).then(resolve);
                        }, 500 * (retryCount + 1));
                    } else {
                        recordTabFailure(
                            tab,
                            chrome.runtime.lastError.message || t('errorReloadFailed'),
                            generation
                        );
                        resolve(false);
                    }
                } else {
                    // Scheduled only after the reload is dispatched: an
                    // already-loading tab can otherwise reach "complete" for
                    // its previous navigation and consume the saved state.
                    if (!isStaleGeneration(generation) && hasStateToRestore) {
                        scheduleMediaRestore(tab.id);
                    }
                    resolve(true);
                }
            });
        });
    } catch (error) {
        basicReload(tab, retryCount, resolve, generation);
    }
}

// Basic reload without trying to preserve state
function basicReload(tab, retryCount, resolve, generation) {
    if (isStaleGeneration(generation)) {
        resolve('skipped');
        return;
    }

    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
        if (chrome.runtime.lastError) {
            if (retryCount < MAX_RETRIES) {
                // Retry with backoff
                setTimeout(() => {
                    if (isStaleGeneration(generation)) { resolve('skipped'); return; }
                    refreshTab(tab, retryCount + 1, undefined, generation).then(resolve);
                }, 500 * (retryCount + 1));
            } else {
                recordTabFailure(
                    tab,
                    chrome.runtime.lastError.message || t('errorReloadFailed'),
                    generation
                );
                resolve(false);
            }
        } else {
            resolve(true);
        }
    });
}

// Helper to handle refresh errors
async function handleRefreshError(tab, error, retryCount, generation) {
    console.error(`Error refreshing tab ${tab.id}:`, error);

    if (retryCount < MAX_RETRIES) {
        // Retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
        if (isStaleGeneration(generation)) return 'skipped';
        return refreshTab(tab, retryCount + 1, undefined, generation);
    }

    recordTabFailure(tab, error.message || t('errorUnknown'), generation);
    return false;
}

// Helper to handle tab refresh errors
function handleTabRefreshError(tab, error, retryCount, resolve, generation) {
    console.error(`Error refreshing tab ${tab.id}:`, error);

    if (retryCount < MAX_RETRIES) {
        // Retry with exponential backoff
        setTimeout(() => {
            if (isStaleGeneration(generation)) { resolve('skipped'); return; }
            refreshTab(tab, retryCount + 1, undefined, generation).then(resolve);
        }, 500 * Math.pow(2, retryCount));
    } else {
        recordTabFailure(tab, error.message || t('errorUnknownDuringRefresh'), generation);
        resolve(false);
    }
}

// Function to update progress
function updateProgress(current, total, generation) {
    if (!activeRefreshOperation || isStaleGeneration(generation)) return;

    if (!total) {
        chrome.action.setBadgeText({ text: "" });
        return;
    }

    const percent = Math.floor((current / total) * 100);
    chrome.action.setBadgeText({ text: percent + "%" });

    // Broadcast progress to popup
    chrome.runtime.sendMessage({
        action: 'refreshProgress',
        generation,
        current,
        total,
        percent,
        successful: refreshedTabs,
        failed: failedTabs.length,
        skipped: skippedTabs.length
    }).catch(() => {
        // Popup might be closed, ignore error
    });
}

// Function to save operation to history
function saveToHistory(operation, onSaved = () => {}) {
    chrome.storage.local.get(['refreshHistory'], (result) => {
        const history = result.refreshHistory || [];

        // Add newest operation at the beginning
        history.unshift(operation);

        const limitedHistory = history.slice(0, 10);

        chrome.storage.local.set({ refreshHistory: limitedHistory }, onSaved);
    });
}

function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Function to preserve media state before refresh
function preserveMediaState() {
    try {
        let staleBytes = 0;
        try {
            for (const entry of performance.getEntriesByType('resource')) {
                if (entry.transferSize === 0 && entry.decodedBodySize > 0) {
                    staleBytes += entry.encodedBodySize;
                }
            }
        } catch (error) {
            staleBytes = 0;
        }

        const videos = document.querySelectorAll('video');
        const audios = document.querySelectorAll('audio');
        let mediaStates = {};

        // Store video states - with special handling for YouTube.
        // currentSrc leads because it is the only identity a <source> child
        // exposes; .src stays empty for those elements. It falls back to .src
        // for elements whose resource selection has not run yet.
        videos.forEach((video, index) => {
            const isYouTube = window.location.hostname.includes('youtube.com');

            mediaStates[`video_${index}`] = {
                src: video.currentSrc || video.src || (isYouTube ? 'youtube_video' : 'video_element'),
                currentTime: video.currentTime,
                paused: video.paused,
                muted: video.muted,
                volume: video.volume,
                playbackRate: video.playbackRate,
                isYouTube: isYouTube
            };
        });

        // Store audio states
        audios.forEach((audio, index) => {
            // Capture audio state even if src is empty
            mediaStates[`audio_${index}`] = {
                src: audio.currentSrc || audio.src || 'audio_element',
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
            return { success: true, count: Object.keys(mediaStates).length, staleBytes };
        }

        return { success: true, count: 0, staleBytes };
    } catch (error) {
        console.error("Error preserving media state:", error);
        return { success: false, error: error.message };
    }
}
