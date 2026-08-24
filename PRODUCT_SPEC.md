# Product Specification: Refresh Em All

## 1. Product Overview
**Refresh Em All** is a lightweight, high-performance Chromium browser extension designed to perform cache-bypassing reloads of accessible tabs across every open window. Its reloads are similar in purpose to a hard refresh such as Command+Shift+R on macOS. Unlike simple refresh extensions, it prioritizes system stability, memory efficiency, and user control through smart batching and comprehensive error handling.

The product bypasses local cache during each reload. It does not delete cached browsing data or modify cookies, Cache Storage, service workers, or other site data.

### Vision
To provide the most reliable and safe method for bulk-refreshing browser tabs, ensuring that even users with hundreds of open tabs can refresh them without crashing their browser or losing their place.

## 2. Target Audience
- **Power Users**: Users with high tab counts (50-100+) who need to update content across all sessions.
- **Developers & QA**: Professionals who need to bulk-reload environments or stress-test web applications.
- **General Users**: Anyone needing a quick "reset" for their browsing session.

## 3. detailed Feature Specifications

### 3.1 Core Functionality
- **Accessible-Tab Scope**: queries `chrome.tabs` across *all* windows, not just the current one, and processes every tab with a valid tab ID. Known browser-internal and extension pages are skipped.
- **Cache-Bypass Invariant**: every actual tab reload must call `chrome.tabs.reload(tabId, { bypassCache: true })`. Normal, discarded, media-capture fallback, retry, loading-wait, and error-recovery paths must never substitute a standard cached reload.
- **Hard-Refresh-Style Behavior**: each reload bypasses local cache for that load. The extension does not delete cache entries or other browsing data.
- **Smart Batch Processing**:
  - Automatically groups tabs into manageable batches (e.g., 3-5 tabs) to prevent CPU spikes.
  - Dynamically adjusts batch size based on total tab count (fewer concurrent refreshes for 50+ tabs).
  - Enforces delays between batches to allow Chrome's garbage collector to run.
- **Discarded Tab Handling**: Detects tabs that have been discarded (sleeping) by Chrome and performs a cache-bypassing reload without changing the user's active tab. Because a discarded tab's document is unloaded, media state cannot be captured first.
- **Sequential Execution**: Processes the queue sequentially to maintain browser responsiveness.
- **Result Semantics**: A tab is counted as refreshed when Chrome accepts the reload request without a `runtime.lastError`. This does not guarantee that the resulting page later finishes loading successfully.

### 3.2 State Preservation
- **Media Preservation**: Before refreshing a normal, non-discarded tab, the extension scans for `<video>` and `<audio>` elements when the optional `<all_urls>` host permission has been granted. It attempts to capture playback position, play/pause, mute, volume, and playback rate in the page's own `sessionStorage` for restoration after reload. The host page can read that state while it exists. Restoration is best effort and depends on the page's media implementation and Chrome's autoplay rules.
- **No-Permission Path**: Without the optional host permission, the extension skips script injection and proceeds directly to a cache-bypassing reload. It does not capture media state or measure cached resource bytes on that path.
- **Capture Failure Fallback**: If media capture is denied or throws, the tab is still reloaded with local-cache bypass; the fallback omits media preservation, not cache bypass.

### 3.3 Cache Measurement
- **Measurement**: Before each scripted reload, the injected `preserveMediaState` function reads `performance.getEntriesByType('resource')`. It sums `encodedBodySize` only when `transferSize === 0 && decodedBodySize > 0`; it does not read or retain timing values.
- **Lower-Bound Semantics**: Every displayed cache figure is "at least" the recorded byte count. Some cross-origin resources do not expose their sizes, and Chrome's Resource Timing buffer holds 250 entries by default; the extension does not enlarge it. Both limits can cause undercounting, so the real number can be higher but not lower.
- **Aggregation**: `chrome.storage.local.cacheStats` stores byte counts for `lastRun`, `total`, and at most 31 daily buckets keyed by local date. Completing a refresh without optional host access still records `lastRun: 0`; retained daily buckets continue to age through the rolling 7-day and 30-day windows.

### 3.4 Error Management
- **Robust Error Handling**:
  - Captures refresh failures (e.g., offline, crashed renderer).
  - Implements exponential backoff for retrying failed tabs.
  - Gracefully skips system pages (e.g., `chrome://` URLs) that cannot be scripted.
  - Retries route through the same cache-bypassing reload invariant, up to two retries after the initial attempt.
  - Continuously loading tabs receive a bounded wait before the cache-bypassing reload proceeds.
  - A per-tab timeout records a failure and continues the queue without issuing a standard cached fallback.
- **Cancellation**: The popup can request cancellation. The worker stops before further queued work and records the processed, successful, failed, and skipped counts reached before cancellation.
- **Interrupted-Operation Recovery**: Progress is persisted in `chrome.storage.session`. If the popup finds a stored operation marked active after the service worker no longer has an active operation, it marks and displays the run as interrupted rather than pretending it completed or resuming it automatically.
- **Garbage Collection**: Explicitly hints for garbage collection after batches when run in environments exposing `gc()`.

### 3.5 User Interface
- **Popup Dashboard**:
  - **Start Button**: Single prominent action to initiate process.
  - **Cancel Button**: Available during an active refresh and reports cancellation failures.
  - **Progress Visuals**:
    - Linear progress bar showing percentage complete.
    - Dynamic status text (`Refreshing 5/20 tabs...`).
    - Granular tab list showing status indicators (Loading, Success ✓, Error ✗) for every individual tab.
  - **Visual Feedback**: Confetti animation upon successful completion of all tabs.
- **History Log**: Keeps a local record of the last 10 refresh operations, detailing success rates and timestamps.
- **Cache Statistics**: Shows the last run, today, rolling 7-day, rolling 30-day, and all-time measured byte totals as lower-bound figures. Settings provides a local reset for `cacheStats`.
- **Optional Host Access**: The first refresh on a fresh profile asks once for `<all_urls>` access. Settings keeps a permanent control for requesting it later, and refusal does not block reloads.
- **Operation Recovery**: Reopening the popup restores active progress from session storage or reports that an operation was interrupted.
- **Error Reporting**:
  - Detailed local view of specific tab errors in the UI.
  - No browsing data or telemetry is sent to external services.

### 3.6 Developer & QA Features
- **Localization**:
  - English and Turkish interface text via Chrome's built-in `chrome.i18n`.
  - Follows the browser UI language; English is the fallback locale.

## 4. Technical Architecture
- **Manifest Version**: V3
- **Permissions Required**:
  - `tabs`: To query and manipulate tabs.
  - `scripting`: To inject cache measurement and media capture before reload, then inject media restoration after reload when optional host access is available.
  - `storage`: To save session operation state, local refresh history, `cacheStats`, and the one-time `mediaAccessAsked` prompt flag, and to migrate legacy extension storage. Media state uses the relevant page's `sessionStorage`, not the Chrome `storage` permission.
- **Optional Host Permission**:
  - `<all_urls>`: Requested at runtime from the first refresh or the permanent Settings control. It enables cache measurement and media capture/restoration on supported pages; reloads still proceed without it.
- **Local Processing**: All logic runs client-side. No user data or telemetry is sent to external servers.

## 5. Non-Functional Requirements
- **Performance**: Must not cause browser "Aw, Snap!" crashes even with 100+ tabs.
- **Responsiveness**: The popup UI must remain responsive during the refresh cycle.
- **Reliability**: Must verify that a tab actually exists before attempting to refresh it, handling race conditions where a user closes a tab mid-process.
- **Cache-Bypass Verification**: Unit tests must assert `{ bypassCache: true }` for every reload route and every retry. Browser tests must verify that a long-lived cacheable resource is requested from the server again by both the source and packaged extensions.
