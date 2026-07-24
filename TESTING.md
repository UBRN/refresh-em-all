# Testing Guide for Refresh Em All

## Current status

- Unit/integration tests: **16/16 passing**
- Browser E2E tests: **4/4 passing**
- Reliability test: **50 tabs across 2 windows, including paused and playing media**
- Statement coverage: **65.47%**
- Line coverage: **67.72%**

The unit tests instrument the extension scripts before executing them, so Jest now reports coverage for dynamically loaded extension code instead of 0%.

## Requirements

- Node.js 18 through 25
- npm
- Chrome or the Chromium build bundled with Puppeteer

Node 26 is not currently supported by the installed Puppeteer dependency chain.

## Commands

```bash
npm test
npm run test:watch
npm run test:coverage
npm run e2e
npm run e2e:reliability
npm run verify
npm run stress-test
```

## Unit and integration coverage

### Background worker

- Starts refreshes through popup messages
- Separates refreshed, failed, and skipped tabs
- Emits per-tab results and processed progress
- Retries failures and reaches a terminal state
- Bounds waits for continuously loading tabs
- Cancels active operations
- Migrates old Chrome Sync history without retaining titles or URLs

### Popup

- Prevents duplicate refresh starts
- Displays per-tab success, failure, and skipped states
- Restores progress when the popup is reopened
- Activates stress mode without replacing the main click handler
- Renders sanitized local history through DOM text nodes

### Content script

- Restores paused and playing media state
- Waits for media metadata before restoring timestamps
- Handles dynamically inserted media
- Avoids telemetry and browsing-data messages
- Recovers from corrupted session state

## Browser E2E coverage

The browser suite starts a localhost-only test server and loads the unpacked extension into Chrome. It verifies:

1. Two real pages reload exactly once.
2. Restricted browser and extension pages are reported as skipped, not refreshed.
3. Progress reaches 100% and local history contains the correct sanitized counts.
4. The settings UI accurately states that telemetry is disabled.
5. Refresh history renders safely.
6. Stress mode activates without popup JavaScript errors.

## Reliability coverage

`npm run e2e:reliability` starts 50 localhost tabs split evenly across two real
Chrome windows. It verifies that every page reloads exactly once, the operation
reaches 100% with accurate history counts, and paused and playing audio retain
their playback position, volume, mute state, and playback rate.

The test uses a generated local audio file and disables Chrome's user-gesture
requirement for autoplay so playback restoration is deterministic. Real streaming
sites still require the manual autoplay-policy checks below.

## Continuous integration

GitHub Actions runs unit/integration, browser E2E, and 50-tab reliability tests
on pull requests. The same workflow runs on changes to `main`, weekly, and when
started manually from the Actions page.

## Verification and stress tests

`npm run verify` exercises a larger browser flow and writes diagnostic screenshots/results under `tests/`.

`npm run stress-test` increases tab counts and records timing and memory information. A run now exits unsuccessfully if it records errors, a crash point, or repeated timeouts; failed runs are no longer marked as passed.

## Remaining manual checks

- Playback restoration on YouTube and streaming sites, including autoplay-policy behavior
- Multiple browser windows with discarded tabs
- 100-tab responsiveness on representative user hardware
- Chrome, Edge, and Brave compatibility
