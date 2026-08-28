# Testing Guide for Refresh Em All

## Current status

- Jest unit/integration/contract suite: **99 tests across 6 suites**
- Fast browser suite: **6 scenarios** (the denied-access path, 4 essential scenarios, and the 8-tab smoke profile)
- Full reliability profile: **50 tabs across 2 windows, including paused and playing media**

The unit tests instrument the extension scripts before executing them, so Jest now reports coverage for dynamically loaded extension code instead of 0%.
Static coverage percentages are not kept here because an undated snapshot quickly becomes stale. Run `npm run test:coverage` for a current local report.

## Requirements

- Node.js 18 through 25
- npm
- Chrome or the Chromium build bundled with Puppeteer

Node 24 LTS is the CI and local-development default recorded in `.nvmrc`.
Node 26 is not currently supported by the installed Puppeteer dependency chain.
Install the locked dependencies with `npm ci --legacy-peer-deps`; the flag is
needed for the documented `jest-chrome`/Jest peer-version mismatch.

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
npm run verify
npm run stress-test
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
  fallback, synchronous fallback, loading-wait, retry, and timeout paths
- Proves a stalled reload times out without issuing a standard cached fallback
- Cancels active operations
- Finalizes cancellation immediately and prevents stale callbacks and retries from mutating a replacement refresh
- Resumes active session snapshots from their processed-tab cursor and caps repeated resumes
- Ignores inactive snapshots and safely reconciles completed, capped, and malformed session state
- Excludes late script measurements from the replacement refresh's cache statistics
- Discards a tab query or permission result that belongs to a cancelled generation
- Cancels a restored operation whose permission lookup is still pending
- Refuses to capture or reload for a tab whose generation was cancelled mid-callback
- Serializes back-to-back finalizations so neither run loses statistics or history order
- Carries the operation generation in worker state and in every progress broadcast
- Filters malformed tab records out of a restored snapshot and normalizes it for the popup
- Resets the resume budget when a new manual refresh starts
- Drops tab records when reconciling an interrupted operation
- Migrates old Chrome Sync history without retaining titles or URLs

### Popup

- Prevents duplicate refresh starts
- Requests optional host access from the first refresh only once and still starts after refusal
- Provides the permanent Settings request path and renders both granted and denied states
- Displays per-tab success, failure, and skipped states
- Restores progress when the popup is reopened
- Renders sanitized local history through DOM text nodes
- Renders last-run, daily, rolling, and all-time cache statistics and resets them locally
- Keeps the refresh control disabled until initialization settles and re-enables it after a refused permission request
- Ignores a late cancel callback that arrives after the run has already finished
- Renders errors that were collected before a run was cancelled
- Sets `aria-valuenow` to match the progress bar width when a restored run was interrupted
- Ignores progress and completion messages from an older operation generation

### Localization

- English and Turkish catalogs have matching keys and placeholders
- Manifest `default_locale` and every `__MSG_*__` reference resolve
- Both locale catalogs are inside the packaged runtime allowlist
- `chrome.i18n` substitutes dynamic placeholders in catalog order
- Turkish popup text, history, and accessibility labels render from the catalog
- The production popup contains no hidden stress-test hooks

### Content script

- Restores paused and playing media state
- Waits for media metadata before restoring timestamps
- Handles dynamically inserted media
- Avoids telemetry and browsing-data messages
- Recovers from corrupted session state
- Skips restoring audio state when reordered sources no longer match the saved source
- Restores a source-less audio element from saved state

### E2E harness and release workflow contracts

- Bounds harness concurrency while preserving result order and exercises the smoke, medium, and full profile ranges
- Keeps release publication tag-only, explicitly targeted at GitHub, and limited to the required write permission

## Cache measurement limits

The cache-byte figures are lower bounds. Some cross-origin files do not expose their sizes, and Chrome keeps 250 Resource Timing entries by default. The extension reads the entries already present and never enlarges that buffer, so additional resources can be omitted. It reads only `transferSize`, `decodedBodySize`, and `encodedBodySize`; it does not collect timing values.

Without optional host access, refreshes still run but no new cache bytes are measured. Completion records `lastRun` as zero, and the rolling 7-day and 30-day totals continue to change as retained daily buckets age out.

## Fast pull-request suite

`npm run e2e` first creates a denied-access harness, then a normal harness. Each harness
uses its own temporary extension copy, localhost-only server, isolated profile, and
extension-enabled browser. The denied harness leaves optional host access ungranted. For
the normal harness, setup temporarily replaces the copied shipped manifest with one that
requires `<all_urls>` instead of declaring it optional, launches Chrome to seed the grant, restores the shipped
manifest, and relaunches Chrome on the same profile. The normal harness then runs the
essential scenarios sequentially, resets extension storage between scenarios, and finishes
with the 8-tab, two-window smoke profile. Together the harnesses verify:

1. Without optional host access, real pages still reload and media restoration is not injected.
2. Two real pages reload exactly once while Chrome and extension pages are reported as skipped,
   progress reaches 100%, and local history contains sanitized counts.
3. A JavaScript resource served with a one-day immutable cache lifetime remains
   cached across a normal reload, then is requested from the server again after
   the extension reloads its page.
4. The settings UI accurately states that telemetry is disabled.
5. Refresh history renders safely.
6. Eight tabs across two windows reload once while paused and playing media state is preserved.

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

The medium profile crosses the extension's `>20` queried-tab batching threshold.
The full profile crosses the `>50` threshold and preserves the original 25-tabs-
per-window assertion.

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

## Verification and stress tests

`npm run verify` exercises a larger browser flow and writes diagnostic screenshots/results under `test-results/verification/`.

`npm run stress-test` increases tab counts and records timing and memory information under `test-results/stress/`. A run exits unsuccessfully if it records errors, a crash point, or repeated timeouts; failed runs are not marked as passed.

## Remaining manual checks

- Playback restoration on YouTube and streaming sites, including autoplay-policy behavior
- Multiple browser windows with discarded tabs
- 100-tab responsiveness on representative user hardware
- Chrome, Edge, and Brave compatibility
