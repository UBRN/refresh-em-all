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
// The count starts from the clock, not from zero: Chrome restarts the worker
// often, and an open popup drops any generation below the one it is showing, so a
// restarted worker must never reuse a number. Date.now() is about 1.7e12, far below 2^53.
let currentGeneration = Date.now();
// Finalization does a read-modify-write of cacheStats and refreshHistory. Two runs
// can finalize close together (a cancel followed straight away by a new refresh),
// so they queue instead of interleaving.
let finalizeQueue = Promise.resolve();
let batchTimeoutId = null;
let staleBytesThisRun = 0;
// True when the run covers only the tab the popup was opened over.
let singleTabRun = false;
let hasSiteAccess = false;

// Tabs the extension just reloaded that are still waiting for media restoration.
const pendingMediaRestores = {};
let pendingMediaRestoreQueue = Promise.resolve();
const MEDIA_RESTORE_TIMEOUT_MS = 30000;

// Constants for tab processing
const MAX_TABS_PER_BATCH = 5; // Process tabs in smaller batches
const TAB_PROCESSING_INTERVAL = 75; // ms between tab refreshes
const MAX_RETRIES = 2; // Number of retries for failed tab refreshes
const BATCH_INTERVAL = 250; // ms between batches
const MAX_LOADING_WAIT_MS = 10000;
const MAX_TAB_REFRESH_MS = 30000;
// A page that never answers the media capture still gets reloaded, just without it.
const MEDIA_CAPTURE_TIMEOUT_MS = 3000;

function isStaleGeneration(generation) {
    return generation !== currentGeneration || operationFinalized;
}

// One tab's refresh attempt. Once its timeout fires the tab is already reported as
// failed, so the work still in flight must not reload it or add its bytes.
function isStaleAttempt(attempt) {
    return attempt.timedOut || isStaleGeneration(attempt.generation);
}

function readPendingMediaRestores() {
    if (!chrome.storage.session) return Promise.resolve({ ...pendingMediaRestores });

    return new Promise(resolve => {
        chrome.storage.session.get(['pendingMediaRestores'], result => {
            const stored = result.pendingMediaRestores;
            resolve(stored && typeof stored === 'object' && !Array.isArray(stored)
                ? { ...stored }
                : {});
        });
    });
}

function writePendingMediaRestores(restores) {
    const now = Date.now();
    const current = Object.fromEntries(Object.entries(restores)
        .filter(([, expiresAt]) => Number.isFinite(expiresAt) && now < expiresAt));

    if (!chrome.storage.session) {
        Object.keys(pendingMediaRestores).forEach(tabId => delete pendingMediaRestores[tabId]);
        Object.assign(pendingMediaRestores, current);
        return Promise.resolve();
    }

    return new Promise(resolve => {
        chrome.storage.session.set({ pendingMediaRestores: current }, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

function updatePendingMediaRestores(update) {
    pendingMediaRestoreQueue = pendingMediaRestoreQueue.then(async () => {
        const restores = await readPendingMediaRestores();
        const before = JSON.stringify(restores);
        const result = update(restores);
        // Every page load in the browser passes through here; most change nothing.
        if (JSON.stringify(restores) !== before) await writePendingMediaRestores(restores);
        return result;
    });
    return pendingMediaRestoreQueue;
}

function clearPendingMediaRestore(tabId) {
    return updatePendingMediaRestores(restores => {
        delete restores[tabId];
    });
}

function scheduleMediaRestore(tabId) {
    return updatePendingMediaRestores(restores => {
        restores[tabId] = Date.now() + MEDIA_RESTORE_TIMEOUT_MS;
    });
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;

    const shouldRestore = await updatePendingMediaRestores(restores => {
        const expiresAt = restores[tabId];
        delete restores[tabId];
        return Number.isFinite(expiresAt) && Date.now() < expiresAt;
    });
    if (shouldRestore) restoreMediaStateInTab(tabId);
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
        // Normal and incognito tabs stay apart: a run covers only the tabs of the
        // same kind as the window the popup was opened from.
        const incognito = message.incognito === true;
        // With a tab id the run covers that one tab and takes the same lock,
        // cancel, history and statistics path as a run over every tab.
        const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
        singleTabRun = tabId !== null;

        chrome.tabs.query({}, (tabs) => {
            const scope = tabId === null || !Array.isArray(tabs)
                ? tabs
                : tabs.filter(tab => tab.id === tabId);
            initializeAndStartRefresh(scope, sendResponse, generation, incognito).catch(error => {
                console.error('[Refresh Em All] Refresh start failed:', error);
                endRefreshOperation(false, generation);
            });
        });
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
                // An interrupted run is reported once; after that it lives in history.
                if (storedState?.interrupted) clearPersistedOperationState();
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
        singleTab: singleTabRun,
        cancelled: operationCancelled,
        startTime: startTime ? startTime.toISOString() : null,
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

// A run whose worker stopped before it finished is not continued: the user did not
// ask for those reloads at this later moment. It goes into history with the counts
// it reached, and the popup reports the interruption once.
function recordInterruptedOperation() {
    if (!chrome.storage.session || activeRefreshOperation) return;

    chrome.storage.session.get(['refreshOperationState'], (result) => {
        if (chrome.runtime.lastError) return;

        const stored = result.refreshOperationState;
        if (!stored || stored.active !== true) return;
        if (activeRefreshOperation) return;

        startRefreshOperation();
        const generation = currentGeneration;
        const normalized = normalizeStoredOperation(stored);
        tabsToRefresh = normalized.currentTabs.filter(isTabRecord);
        processedTabs = Number.isFinite(stored.processedTabs) ? stored.processedTabs : 0;
        refreshedTabs = Number.isFinite(stored.refreshedTabs) ? stored.refreshedTabs : 0;
        failedTabs = normalized.failedTabDetails.filter(isTabRecord);
        skippedTabs = Array.isArray(stored.skippedTabIds)
            ? stored.skippedTabIds.filter(Number.isInteger)
            : [];
        staleBytesThisRun = Number.isFinite(stored.staleBytes) ? stored.staleBytes : 0;
        singleTabRun = stored.singleTab === true;
        const restoredStartTime = new Date(stored.startTime);
        if (stored.startTime && !Number.isNaN(restoredStartTime.getTime())) startTime = restoredStartTime;
        // A cancel that was accepted before the worker stopped is a cancellation, not an interruption.
        operationCancelled = stored.cancelled === true;
        const interrupted = !operationCancelled;

        endRefreshOperation(false, generation, interrupted);
        if (!interrupted) return;

        // Tab records are dropped on purpose: the popup only reports progress for an
        // interrupted run, so there is no reason to keep URLs or titles in session
        // storage. endRefreshOperation dispatches the clear first, so this write survives.
        const totalTabs = tabsToRefresh.length;
        chrome.storage.session.set({
            refreshOperationState: {
                active: false,
                interrupted: true,
                progress: totalTabs > 0 ? Math.round((processedTabs / totalTabs) * 100) : 0,
                totalTabs,
                processedTabs,
                refreshedTabs,
                failedTabs: failedTabs.length,
                skippedTabs: skippedTabs.length,
                singleTab: singleTabRun,
                lastUpdated: new Date().toISOString()
            }
        }, () => {
            void chrome.runtime.lastError;
        });
    });
}

// Prepare and start the refresh operation once tabs are available
async function initializeAndStartRefresh(tabs, sendResponse, generation, incognito) {
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
    tabsToRefresh = tabs.filter(tab => Number.isInteger(tab.id)
        && tab.id !== chrome.tabs.TAB_ID_NONE
        && (tab.incognito === true) === incognito);

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

    tabStatuses = Object.fromEntries(tabsToRefresh.map(tab => [tab.id, 'pending']));
    persistOperationState();

    // Let the popup initialize its UI with the tab list
    chrome.runtime.sendMessage({
        action: 'refreshStarted',
        generation,
        singleTab: singleTabRun,
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

    failedTabs = [{
        title: t('errorStartFailureTabTitle'),
        url: 'N/A',
        error: errorMessage
    }];

    if (typeof sendResponse === 'function') {
        sendResponse({ success: false, message: errorMessage });
    }

    endRefreshOperation(false, generation);
}

recordInterruptedOperation();

// Function to start refresh operation
function startRefreshOperation() {
    currentGeneration++;
    activeRefreshOperation = true;
    operationFinalized = false;
    operationCancelled = false;
    // Reset every per-run field at the claim, not after the permission lookup: a
    // run cancelled in between must not finalize with the previous run's counts.
    tabsToRefresh = [];
    refreshedTabs = 0;
    processedTabs = 0;
    failedTabs = [];
    skippedTabs = [];
    tabStatuses = {};
    staleBytesThisRun = 0;
    singleTabRun = false;
    startTime = new Date();

    // No icon swap here: the badge below is what signals that a refresh is running.

    // Update badge to show progress
    chrome.action.setBadgeBackgroundColor({ color: "#4285f4" });
    chrome.action.setBadgeText({ text: "0%" });
}

// Function to end refresh operation
function endRefreshOperation(success = true, generation, interrupted = false) {
    if (generation !== currentGeneration || operationFinalized) return;
    operationFinalized = true;
    activeRefreshOperation = false;
    const finalSuccess = success && !operationCancelled && failedTabs.length === 0;

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
        singleTab: singleTabRun,
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
    if (interrupted) historyEntry.interrupted = true;
    if (singleTabRun) historyEntry.singleTab = true;

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
    const attempt = { generation, timedOut: false, staleBytesCounted: false };
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            attempt.timedOut = true;
            reject(new Error(t('errorRefreshTimeout', MAX_TAB_REFRESH_MS / 1000)));
        }, MAX_TAB_REFRESH_MS);

        refreshTab(tab, 0, undefined, attempt)
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

async function refreshTab(tab, retryCount = 0, loadingWaitStartedAt = Date.now(), attempt) {
    if (!tab || !Number.isInteger(tab.id) || tab.id === chrome.tabs.TAB_ID_NONE) {
        return 'skipped';
    }

    // Check if tab still exists
    return new Promise((resolve) => {
        chrome.tabs.get(tab.id, (tabInfo) => {
            if (isStaleAttempt(attempt)) {
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
                    if (isStaleAttempt(attempt)) { resolve('skipped'); return; }
                    refreshTab(tab, retryCount, loadingWaitStartedAt, attempt).then(resolve);
                }, 500);
                return;
            }

            if (tabInfo.discarded || !hasSiteAccess) {
                // Discarded tabs reload without changing the user's active tab, and
                // have no live media to capture. Without site access the capture
                // injection would be rejected for every tab, so skip straight past it.
                basicReload(tab, retryCount, resolve, attempt);
            } else {
                preserveStateAndRefreshTab(tab, retryCount, resolve, attempt);
            }
        });
    });
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
function preserveStateAndRefreshTab(tab, retryCount, resolve, attempt) {
    // Try to save media state before refreshing, but handle errors gracefully.
    // A busy or hung page can hold the capture callback for the whole per-tab
    // timeout; after MEDIA_CAPTURE_TIMEOUT_MS the tab reloads without it, and a
    // late answer is ignored.
    let captureSettled = false;
    const captureTimeoutId = setTimeout(() => {
        captureSettled = true;
        basicReload(tab, retryCount, resolve, attempt);
    }, MEDIA_CAPTURE_TIMEOUT_MS);
    try {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: preserveMediaState
        }, (injectionResults) => {
            if (captureSettled) {
                void chrome.runtime.lastError;
                return;
            }
            captureSettled = true;
            clearTimeout(captureTimeoutId);
            if (isStaleAttempt(attempt)) {
                resolve('skipped');
                return;
            }

            const error = chrome.runtime.lastError;
            if (error) {
                basicReload(tab, retryCount, resolve, attempt);
                return;
            }

            // A retry captures the same unchanged page again; count its bytes once.
            const measuredStaleBytes = injectionResults?.[0]?.result?.staleBytes;
            if (!attempt.staleBytesCounted && Number.isFinite(measuredStaleBytes)) {
                attempt.staleBytesCounted = true;
                staleBytesThisRun += measuredStaleBytes;
            }
            const capturedCount = injectionResults?.[0]?.result?.count;
            // Unexpected or absent results restore rather than silently dropping captured state.
            const hasStateToRestore = capturedCount !== 0;

            chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
                if (chrome.runtime.lastError) {
                    if (retryCount < MAX_RETRIES) {
                        setTimeout(() => {
                            if (isStaleAttempt(attempt)) { resolve('skipped'); return; }
                            refreshTab(tab, retryCount + 1, undefined, attempt).then(resolve);
                        }, 500 * (retryCount + 1));
                    } else {
                        recordTabFailure(
                            tab,
                            chrome.runtime.lastError.message || t('errorReloadFailed'),
                            attempt.generation
                        );
                        resolve(false);
                    }
                } else {
                    // Scheduled only after the reload is dispatched: an
                    // already-loading tab can otherwise reach "complete" for
                    // its previous navigation and consume the saved state.
                    if (!isStaleAttempt(attempt) && hasStateToRestore) {
                        scheduleMediaRestore(tab.id);
                    }
                    resolve(true);
                }
            });
        });
    } catch (error) {
        captureSettled = true;
        clearTimeout(captureTimeoutId);
        basicReload(tab, retryCount, resolve, attempt);
    }
}

// Basic reload without trying to preserve state
function basicReload(tab, retryCount, resolve, attempt) {
    if (isStaleAttempt(attempt)) {
        resolve('skipped');
        return;
    }

    chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
        if (chrome.runtime.lastError) {
            if (retryCount < MAX_RETRIES) {
                // Retry with backoff
                setTimeout(() => {
                    if (isStaleAttempt(attempt)) { resolve('skipped'); return; }
                    refreshTab(tab, retryCount + 1, undefined, attempt).then(resolve);
                }, 500 * (retryCount + 1));
            } else {
                recordTabFailure(
                    tab,
                    chrome.runtime.lastError.message || t('errorReloadFailed'),
                    attempt.generation
                );
                resolve(false);
            }
        } else {
            resolve(true);
        }
    });
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
        const history = Array.isArray(result.refreshHistory) ? result.refreshHistory : [];

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
