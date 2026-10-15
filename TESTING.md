# Testing Guide for Refresh Em All

## Current status

- Jest unit/integration/contract suite: **150 tests across 6 suites**
- Fast browser suite: **9 scenarios** (the first-run question, the denied-access path, 6 essential scenarios, and the 8-tab smoke profile)
- Full reliability profile: **50 tabs across 2 windows, including paused and playing media**

The unit tests instrument the extension scripts before executing them, so Jest now reports coverage for dynamically loaded extension code instead of 0%.
Static coverage percentages are not kept here because an undated snapshot quickly becomes stale. Run `npm run test:coverage` for a current local report.

## Requirements

- Node.js 22.12 through 25
- npm
- Chrome for Testing, which Puppeteer 25.12.0 downloads (Chrome 154)

Node 24 LTS is the CI and local-development default recorded in `.nvmrc`.
Puppeteer 25 requires Node 22.12 or later and is published as an ES module, so the
E2E harness loads it inside the launch function, where Node's `require` handles it and
Jest never does. Node 26 is not currently supported by the dependency chain.
Install the locked dependencies with `npm ci`.

## Commands

```bash
npm test
npm run test:watch
npm run test:coverage
npm run e2e
npm run e2e:package
npm run e2e:reliability:smoke
npm run e2e:reliability:medium
npm run e2e:reliability
npm run e2e:reliability:large
```

## Jest unit, integration, and contract coverage

### Background worker

- Starts refreshes through popup messages
- Separates refreshed, failed, and skipped tabs
- Emits per-tab results and processed progress
- Measures only cached resource `encodedBodySize` values whose `transferSize` is zero and whose `decodedBodySize` is positive
- Merges `cacheStats`, records each run including zero-byte runs, and prunes daily totals to 31 local dates
- Retries failures and reaches a terminal state
- Bounds waits for continuously loading tabs
- Reloads ordinary tabs without script injection when optional host access is absent
- Refreshes a tab that navigated away from a restricted URL before its turn instead of skipping it
- Skips a tab that navigated to a restricted URL before its turn
- Requires `{ bypassCache: true }` on normal, discarded, media-capture
  fallback, loading-wait, retry, and timeout paths
- Proves a stalled reload times out without issuing a standard cached fallback
- Cancels active operations
- Finalizes cancellation immediately and prevents stale callbacks and retries from mutating a replacement refresh
- Records a run whose worker stopped as interrupted in history instead of resuming it, records an already-cancelled one as cancelled, and reports the interruption to the popup once
- Holds a status or start request that wakes the worker until a stopped run is recorded, so the stopped run is never served as live or left out of history, and marks its completion message as interrupted
- Ignores inactive snapshots and safely reconciles malformed session state
- Starts each worker lifetime above the generations a previous worker used
- Refreshes only tabs whose incognito mode matches the window that started the run
- Keeps an incognito run, finished or interrupted, out of history and cache statistics
- Answers status and cancel requests, and stamps run broadcasts, so that a popup in a window of the other kind neither sees nor cancels the run
- Answers only this extension's own pages, including the popup opened in a tab, and ignores scripts injected into web pages and other extensions
- Stops a timed-out tab attempt from reloading the tab or adding bytes, and counts stale bytes once per tab across retries
- Records a run cancelled during the permission lookup without the previous run's counts or bytes
- Keeps finishing runs when stored history is not a list
- Skips the pending media-restore write when a page load changes nothing
- Excludes late script measurements from the replacement refresh's cache statistics
- Discards a tab query or permission result that belongs to a cancelled generation
- Refuses to capture or reload for a tab whose generation was cancelled mid-callback
- Serializes back-to-back finalizations so neither run loses statistics or history order
- Carries the operation generation in worker state and in every progress broadcast
- Filters malformed tab records out of a stored snapshot and normalizes it for the popup
- Drops tab records when reconciling an interrupted operation
- Refreshes only the requested tab when `startRefresh` carries a `tabId`, through the same lock, history and statistics path
- Reloads the tab under the popup last when `startRefresh` carries an `activeTabId`
- Shows the run's result on the toolbar badge for four seconds (a tick, or a mark after any failure) and clears it after a cancel
- Reloads a tab without media capture when the page does not answer within three seconds, and ignores the late answer
- Records a tab whose reload never answers as timed out and moves on

### Popup

The popup tests load the shipped `popup.html` into jsdom, so a renamed id fails them.

- Every element id `popup.js` looks up and every catalog key `popup.html` names exists
- The popup and the worker skip the same restricted URL schemes
- Prevents duplicate refresh starts and tells the worker the window's incognito mode and active tab
- Asks in the popup before Chrome's permission dialog on the first refresh; "Allow and refresh" requests access once and still starts after refusal, "Just refresh" starts without it, and neither asks again
- Provides the permanent Settings request path and renders both granted and denied states
- Keeps the refresh controls disabled until initialization settles and while a permission request is pending
- Renders per-tab results as dots and keeps `aria-valuenow` on the real value
- Lets the bar creep while a tab is in flight without passing the next step or going back, and never counts an unfinished tab
- Stops the animation loop while the popup is hidden
- Announces start, quarter milestones and the result to screen readers, not every tab
- Ignores progress and completion messages from an older operation generation, and a late cancel callback
- Quiets the tabs that never ran after a cancel and keeps failures in the counts
- Restores a running operation when the popup is reopened and reports an interrupted run once, and shows a run that stops midway as interrupted, without confetti
- Asks about and cancels only runs of its own window kind, ignores the other kind's broadcasts, and only says a reload is running when that run is in a window of the other kind
- Disables both buttons of the permission question while offline, as it does the refresh buttons, and starts no reload when the network drops during Chrome's permission prompt
- Ignores messages from a script injected into a web page
- Keeps the start-failure reason when the worker also reports a zero-tab run
- Plays confetti only after a clean run over every tab that reloaded at least one tab, while the popup is visible, and never on reopen or for a single tab
- Moves keyboard focus between Refresh and Cancel as runs start and end, onto Refresh after a start failure, and between the list and its sub views
- Renders sanitized local history with relative times, single-tab and interrupted labels
- Renders the measured totals as estimates; Reset statistics offers Undo for six seconds and Undo keeps bytes measured since
- Offers "Refresh only this tab" by site name, disables it with a reason on browser pages, keeps it on the Web Store, runs the single-tab path, and names the site when a single-tab run stops

### Localization

- English and Turkish catalogs have matching keys and placeholders
- Manifest `default_locale` and every `__MSG_*__` reference resolve
- Both locale catalogs are inside the packaged runtime allowlist
- `chrome.i18n` substitutes dynamic placeholders in catalog order
- Turkish popup text, the this-tab action, history, and accessibility labels render from the catalog
- The production popup contains no hidden stress-test hooks

### Content script

- Restores paused and playing media state
- Waits for media metadata before restoring timestamps
- Handles dynamically inserted media
- Avoids telemetry and browsing-data messages
- Recovers from corrupted session state
- Skips restoring audio state when reordered sources no longer match the saved source
- Restores a source-less audio element from saved state
- Leaves autoplay alone for media that was paused before it ever started

### E2E harness and release workflow contracts

- Bounds harness concurrency while preserving result order and exercises the smoke, medium, full, and large profile ranges
- Keeps release publication tag-only, explicitly targeted at GitHub, and limited to the required write permission

## Cache measurement limits

The cache-byte figures are lower bounds. Some cross-origin files do not expose their sizes, and Chrome keeps 250 Resource Timing entries by default. The extension reads the entries already present and never enlarges that buffer, so additional resources can be omitted. It reads no timing values, only the resource-size fields described in the background-worker coverage above.

Without optional host access, refreshes still run but no new cache bytes are measured. Completion records `lastRun` as zero, and the rolling 7-day and 30-day totals continue to change as retained daily buckets age out.

## Fast pull-request suite

`npm run e2e` first creates a denied-access harness, then a normal harness. Each harness
uses its own temporary extension copy, localhost-only server, isolated profile, and
extension-enabled browser. The denied harness leaves optional host access ungranted. For
the normal harness, setup temporarily replaces the copied shipped manifest with one that
requires `<all_urls>` instead of declaring it optional, launches Chrome to seed the grant, restores the shipped
manifest, and relaunches Chrome on the same profile. The normal harness then runs the
essential scenarios sequentially, resets extension storage between scenarios, and finishes
with the 8-tab, two-window smoke profile. Most scenarios open `popup.html` in a tab and wait on
`body[data-state]` and the progress bar's `aria-valuenow`. The two toolbar scenarios open the
real popup with `chrome.action.openPopup()`, because only there is the page under the popup the
active tab. Together the harnesses verify:

1. On a fresh profile without host access, the first refresh shows the in-popup question and
   starts nothing; "Just refresh" reloads, the answer is remembered, and the next refresh does
   not ask. Chrome's own permission dialog is not exercised: automation cannot dismiss it.
2. Without optional host access, real pages still reload and media restoration is not injected.
3. Two real pages reload exactly once while Chrome and extension pages are reported as skipped,
   the popup reaches the done state at 100%, and local history contains sanitized counts.
4. A JavaScript resource served with a one-day immutable cache lifetime remains
   cached across a normal reload, then is requested from the server again after
   the extension reloads its page.
5. "Refresh only this tab" in the toolbar popup reloads only the active tab, records a
   single-tab history entry and shows a tick on the toolbar badge.
6. "Refresh All Tabs" in the toolbar popup reloads the tab under the popup last and shows a
   tick on the toolbar badge. Chrome closes the popup when that tab reloads.
7. The settings view accurately states that telemetry is disabled.
8. Refresh history renders safely.
9. Eight tabs across two windows reload once while paused and playing media state is preserved.

The browser suites launch Chrome with `--lang=en-US` because the popup is now
localized and these scenarios assert English status text.

The fast workflow runs the Jest unit/integration/contract suite and this browser suite on every pull
request and every push to `main`. It also runs `npm run e2e:package`, which builds
the release ZIP, extracts it into a temporary directory, and loads that extracted
directory in Chrome. The test verifies the packaged manifest version, popup, one
real tab refresh, and that the same one-day immutable cache probe remains cached
during a normal reload but reaches the server during the extension reload. The
extension is never loaded from the repository root in this test.

## Tiered reliability coverage

All reliability profiles validate two real Chrome windows, exact-once reloads,
100% progress, accurate local history, skipped extension pages, and paused and
playing audio state. They differ only in scale and timeout:

| Command | Tabs | Intended use |
| --- | ---: | --- |
| `npm run e2e:reliability:smoke` | 8 | Fast local/PR smoke coverage |
| `npm run e2e:reliability:medium` | 20 | Changes to tab management, storage, popup/background code, or the service worker |
| `npm run e2e:reliability` | 50 | Weekly, manual, and release-tag full-scale reliability |
| `npm run e2e:reliability:large` | 100 | Manual check before a release that changes tab processing or the service worker |

The medium profile crosses the extension's `>20` queried-tab batching threshold.
The full profile crosses the `>50` threshold and preserves the original 25-tabs-
per-window assertion. The large profile runs 100 tabs, 50 per window; no
workflow runs it.

The profiles use a generated local audio file and disable Chrome's user-gesture
requirement for autoplay so playback restoration is deterministic. Real streaming
sites still require the manual autoplay-policy checks below.

## Continuous integration

GitHub Actions uses three tiers:

1. Fast CI runs the Jest unit/integration/contract suite, essential E2E, and the 8-tab smoke profile on
   every pull request and push to `main`.
2. The 20-tab profile runs when pull requests or `main` pushes change extension,
   package, workflow, or E2E harness files.
3. The 50-tab profile runs weekly, when selected manually from Actions, and as
   release-tag validation. It no longer runs on ordinary pull requests.

The path-filtered medium reliability workflow should not be configured as a
required branch-protection check in its current form: GitHub does not create the
job for pull requests outside its path filters. If it must become required,
trigger the workflow for every pull request and skip its expensive test step
inside the job when the changed paths are irrelevant. No branch-protection
setting is managed by this repository change.

The E2E harness records phase timings under `test-results/e2e/<profile>/timings.json`.
Fast-suite failures are stored in a separate directory for each scenario so one
failure cannot overwrite another. On failure the harness retains screenshots before
closing the popup, browser and extension state, console errors, and, on the full
profile, a Chrome trace. CI uploads these diagnostics for 14 days.

## Remaining manual checks

- Playback restoration on YouTube and streaming sites, including autoplay-policy behavior
- Multiple browser windows with discarded tabs
- 100-tab responsiveness on representative user hardware
- Chrome, Edge, and Brave compatibility
