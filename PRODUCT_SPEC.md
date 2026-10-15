# Product Specification: Refresh Em All

## 1. Product Overview
**Refresh Em All** is a lightweight, high-performance Chromium browser extension designed to perform cache-bypassing reloads of accessible tabs across every open window. Its reloads are similar in purpose to a hard refresh such as Command+Shift+R on macOS. Unlike simple refresh extensions, it prioritizes system stability, memory efficiency, and user control through smart batching and comprehensive error handling.

The product bypasses local cache during each reload. It does not delete cached browsing data or modify cookies, Cache Storage, service workers, or other site data.

### Vision
To provide the most reliable and safe method for bulk-refreshing browser tabs, ensuring that even users with hundreds of open tabs can refresh them without crashing their browser or losing their place.

## 2. Target Audience

The primary audience is **general users**: anyone who needs a quick "reset" for
their browsing session and expects one button to do the obvious thing. Power
users with 50-100+ tabs and developers or QA staff who bulk-reload environments
are served by the same behavior, and the reliability work exists for them, but
they are not who the product is designed around.

This ordering is a design filter, not a description. A proposed feature that
only a power user would find must clear a higher bar than one a general user
would reach for, and several such features have been declined on exactly this
ground. Scheduling, tab-group and domain filtering, an active-window-only
scope, a keyboard shortcut, and a separate options page were all considered and
rejected in August 2026 because they added surface that the primary audience
would not use.

## 3. detailed Feature Specifications

### 3.1 Core Functionality
- **Accessible-Tab Scope**: queries `chrome.tabs` across *all* windows, not just the current one, and processes every tab with a valid tab ID. Known browser-internal and extension pages are skipped. Normal and incognito tabs stay apart: a refresh started from a normal window covers only normal tabs, and one started from an incognito window (when the user allows the extension in incognito) covers only incognito tabs. An incognito run adds nothing to history or cache statistics.
- **Cache-Bypass Invariant**: every actual tab reload must call `chrome.tabs.reload(tabId, { bypassCache: true })`. Normal, discarded, media-capture fallback, retry, loading-wait, and error-recovery paths must never substitute a standard cached reload.
- **Hard-Refresh-Style Behavior**: each reload bypasses local cache for that load. The extension does not delete cache entries or other browsing data.
- **Smart Batch Processing**:
  - Groups tabs into batches: 5 tabs up to 20 tabs, 4 tabs above that, with 75 ms between tabs and 250 ms between batches.
  - There is no slower tier above 50 tabs: it made the 51st tab triple the run time. Sleeping tabs, the bulk of a large session, go back to sleep once reloaded.
  - A woken sleeping tab stays awake until it finishes loading. While 12 of them are still loading, the next batch waits, so a large sleeping session does not load all at once.
- **Discarded Tab Handling**: Detects tabs that have been discarded (sleeping) by Chrome and performs a cache-bypassing reload without changing the user's active tab. Because a discarded tab's document is unloaded, media state cannot be captured first. Once the tab finishes loading, or after 30 seconds, the worker discards it again unless the user switched to it in the meantime (even if they left it again), so a run over many sleeping tabs does not leave them all in memory. Opening it later loads the fresh files from Chrome's cache.
- **Unsaved Text**: With the optional host permission, the pre-reload check also asks the page whether a textarea or text-like input holds typed text that differs from the value it loaded with. A run over every tab leaves such a tab alone, counts it as skipped, and says so in the result; reloading only this tab still reloads it. The page answers yes or no; the text is not stored or sent. Fields a script filled in also count; contenteditable editors and iframes are not checked.
- **Sequential Execution**: Processes the queue sequentially to maintain browser responsiveness.
- **Single-Tab Refresh**: "Refresh only this tab" reloads just the active tab of the popup's window through the same path as a full run: the same cache-bypass invariant, lock, cancellation, history entry (marked `singleTab`) and statistics. It needs no new permission. It is offered only for tabs the worker would not skip, so browser pages (`chrome://`, `about:`, extension pages and the other restricted schemes) disable it with a short reason; the Chrome Web Store, which the worker reloads, keeps it enabled.
- **Active Tab Last**: Chrome closes the popup as soon as the tab under it reloads. A full run therefore reloads that tab last, so the popup can show progress for everything before it.
- **Result Semantics**: A tab is counted as refreshed when Chrome accepts the reload request without a `runtime.lastError`. This does not guarantee that the resulting page later finishes loading successfully.

### 3.2 State Preservation
- **Media Preservation**: Before refreshing a normal, non-discarded tab, the extension scans for `<video>` and `<audio>` elements when the optional `<all_urls>` host permission has been granted. It attempts to capture playback position, play/pause, mute, volume, and playback rate in the page's own `sessionStorage` for restoration after reload. The host page can read that state while it exists. Restoration is best effort and depends on the page's media implementation and Chrome's autoplay rules.
- **No-Permission Path**: Without the optional host permission, the extension skips script injection and proceeds directly to a cache-bypassing reload. It does not capture media state or measure cached resource bytes on that path.
- **Capture Failure Fallback**: If media capture is denied or throws, the tab is still reloaded with local-cache bypass; the fallback omits media preservation, not cache bypass.
- **Capture Timeout**: A page that does not answer the media capture within three seconds is reloaded without it, and a late answer is ignored.
- **Unstarted Media**: Media captured as paused at 0 s was never played, so restoration leaves the page's own autoplay alone instead of holding it paused.

### 3.3 Cache Measurement
- **Measurement**: Before each scripted reload, the injected `preserveMediaState` function reads `performance.getEntriesByType('resource')`. It sums `encodedBodySize` only when `transferSize === 0 && decodedBodySize > 0`; it does not read or retain timing values.
- **Approximate Figures**: The popup shows every cache figure as approximate ("about"). The recorded count is a lower bound: some cross-origin resources do not expose their sizes, and Chrome's Resource Timing buffer holds 250 entries by default, which the extension does not enlarge. Both limits cause undercounting, so the real amount is usually higher.
- **Aggregation**: `chrome.storage.local.cacheStats` stores byte counts for `lastRun`, `total`, and at most 31 daily buckets keyed by local date. Completing a refresh without optional host access still records `lastRun: 0`; retained daily buckets continue to age through the rolling 7-day and 30-day windows.

### 3.4 Error Management
- **Robust Error Handling**:
  - Captures refresh failures (e.g., offline, crashed renderer).
  - Retries failed tabs with a growing delay (500 ms, then 1000 ms).
  - Gracefully skips system pages (e.g., `chrome://` URLs) that cannot be scripted.
  - Retries route through the same cache-bypassing reload invariant, up to two retries after the initial attempt.
  - Continuously loading tabs receive a bounded wait before the cache-bypassing reload proceeds.
  - A per-tab timeout records a failure and continues the queue without issuing a standard cached fallback. Work still in flight for that tab is abandoned: it neither reloads the tab nor adds its measured bytes.
  - Measured stale bytes count once per tab, even when its reload is retried.
- **Cancellation**: The popup can request cancellation. The worker stops before further queued work and records the processed, successful, failed, and skipped counts reached before cancellation.
- **Interrupted-Operation Recovery**: Progress is persisted in `chrome.storage.session`. If Chrome stops the service worker before a run finishes, the next worker start records the run in history as interrupted (an incognito run is not recorded), with the counts it reached, rather than pretending it completed or resuming it automatically. The popup reports the interruption once; a run the user had already cancelled, or cancels from a popup of the run's window kind while the worker restarts, is recorded as cancelled.

### 3.5 User Interface
- **Fixed Frame**: The popup is a fixed 360 by 480 px frame. Its hero, action and detail slots change in place, so the popup window never resizes. Motion is built from the duration, easing and spring tokens at the top of popup.html; it uses no View Transitions and only system fonts. It needs Chrome 117 (`minimum_chrome_version`).
- **Ready Screen**: Before a run, the detail slot says how many tabs the run covers and in how many windows: every tab of the popup window's kind, normal or incognito, the same set the worker counts.
- **Offline**: When the browser reports no network (`navigator.onLine` is false), both refresh buttons are disabled and the ready screen says why, because reloading then turns every tab into an error page. They return when the network does. Only false is trusted; true means a network, not the internet.
- **Retry Failed Tabs**: When the last run failed some tabs that are still open, the ready screen offers to reload only those, in place of the general explanation. The worker keeps the failed tabs' Chrome ids in `chrome.storage.session` under `retryTabIds` for this, so the offer ends when the browser closes; history keeps no tab ids.
- **Refresh All Tabs**: The single primary action. While a run is active its slot shows the progress bar; Cancel sits in the hero, away from it.
- **Progress**: The bar follows the run with a critically damped spring and creeps toward the next step while a tab is in flight, never past 90 percent of that step and never backwards. The count and percent never claim an unfinished tab, and the bar's `aria-valuenow` carries only the real value. One dot per tab shows reloaded, failed and skipped tabs; after a cancel, tabs that never ran stay quiet. The animation stops while the popup is hidden.
- **Result**: A badge and one sentence report the outcome: all reloaded, reloaded with skipped tabs (browser pages, or tabs closed during the run), failed (with the failing tabs and Chrome's reason), or stopped. The measured bytes of the run appear once, counting up.
- **Toolbar Badge**: During a run the toolbar badge shows the percentage. Because Chrome closes the popup when the tab under it reloads, the badge shows the result for four seconds afterwards: a tick after a run that reloaded at least one tab with no failures, a mark after any failure, nothing after a cancel or an interruption.
- **Confetti**: A short canvas burst (44 pieces, 1.5 s, the icon's colors) after a run over every tab that ended with no cancel and no failure, reloaded at least one tab, and finished while the popup was visible. It never plays on reopening the popup or for a single tab.
- **Refresh Only This Tab**: A quiet text button at the bottom of the detail slot, far from the primary button, names the active tab's site and has a short line under it: "Fetches fresh files. Videos pick up where they left off." with page reading allowed, only "Fetches fresh files." without it. On browser pages it is disabled and the line gives the reason.
- **Secondary Views**: Recent reloads, Files Downloaded Again and Settings are one grouped list; each row shows a live summary and opens a view inside the popup.
- **History Log**: Keeps a local record of the last 10 refresh operations with relative times; single-tab, stopped and interrupted runs are labeled.
- **Cache Statistics**: Shows the last run, today, rolling 7-day, rolling 30-day, and all-time measured byte totals as approximate figures. Settings provides a local reset for `cacheStats` with a six-second Undo.
- **Optional Host Access**: The first refresh on a fresh profile first asks in the popup whether to keep videos where they were left, and names the warning Chrome shows next. Only "Allow and refresh" opens Chrome's permission dialog for `<all_urls>`; "Just refresh" reloads without it. Either answer is remembered, so the question appears once. Settings keeps a permanent control for requesting access later, and refusal does not block reloads.
- **Operation Recovery**: Reopening the popup restores active progress from session storage or reports once that an operation was interrupted.
- **Accessibility**: Keyboard focus follows the controls as states change, focus rings stay visible inside the grouped list, long titles never widen the popup, and screen readers hear the start, each quarter of the run and the result rather than every tab.
- **Error Reporting**:
  - Detailed local view of specific tab errors in the UI.
  - No browsing data or telemetry is sent to external services.

### 3.6 Developer & QA Features
- **Localization**:
  - English and Turkish interface text via Chrome's built-in `chrome.i18n`.
  - Follows the browser UI language; English is the fallback locale.

## 4. Technical Architecture
- **Manifest Version**: V3, `minimum_chrome_version` 117
- **Permissions Required**:
  - `tabs`: To query and manipulate tabs.
  - `scripting`: To inject cache measurement and media capture before reload, then inject media restoration after reload when optional host access is available.
  - `storage`: To save session operation state, the `pendingMediaRestores` map in `chrome.storage.session` (`{ tabId: expiry timestamp }`, which keeps a tab's media restoration alive if the MV3 service worker is evicted between reload and completion), the last run's failed tab ids (`retryTabIds`, also in `chrome.storage.session`), local refresh history (entries may carry `singleTab`), `cacheStats`, and the one-time `mediaAccessAsked` prompt flag. The captured media state itself uses the relevant page's `sessionStorage`, not the Chrome `storage` permission.
- **Optional Host Permission**:
  - `<all_urls>`: Requested at runtime from the first refresh or the permanent Settings control. It enables cache measurement, the unsaved-text check and media capture/restoration on supported pages; reloads still proceed without it, and then tabs with typed text reload too.
- **Local Processing**: All logic runs client-side. No user data or telemetry is sent to external servers.

## 5. Non-Functional Requirements
- **Performance**: Must not cause browser "Aw, Snap!" crashes even with 100+ tabs.
- **Responsiveness**: The popup UI must remain responsive during the refresh cycle.
- **Reliability**: Must verify that a tab actually exists before attempting to refresh it, handling race conditions where a user closes a tab mid-process.
- **Cache-Bypass Verification**: Unit tests must assert `{ bypassCache: true }` for every reload route and every retry. Browser tests must verify that a long-lived cacheable resource is requested from the server again by both the source and packaged extensions.
