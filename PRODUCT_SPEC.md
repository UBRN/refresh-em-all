# Product Specification: Refresh Em All

## 1. Product Overview
**Refresh Em All** is a lightweight, high-performance Chromium browser extension designed to refresh all tabs across every open window. Unlike simple refresh extensions, it prioritizes system stability, memory efficiency, and user control through smart batching and comprehensive error handling.

### Vision
To provide the most reliable and safe method for bulk-refreshing browser tabs, ensuring that even users with hundreds of open tabs can refresh them without crashing their browser or losing their place.

## 2. Target Audience
- **Power Users**: Users with high tab counts (50-100+) who need to update content across all sessions.
- **Developers & QA**: Professionals who need to bulk-reload environments or stress-test web applications.
- **General Users**: Anyone needing a quick "reset" for their browsing session.

## 3. detailed Feature Specifications

### 3.1 Core Functionality
- **Universal Refresh**: refreshes `chrome.tabs` across *all* windows, not just the current one.
- **Smart Batch Processing**:
  - Automatically groups tabs into manageable batches (e.g., 3-5 tabs) to prevent CPU spikes.
  - Dynamically adjusts batch size based on total tab count (fewer concurrent refreshes for 50+ tabs).
  - Enforces delays between batches to allow Chrome's garbage collector to run.
- **Discarded Tab Handling**: Detects tabs that have been discarded (sleeping) by Chrome to save memory. It briefly activates them before refreshing to ensure content is actually reloaded.
- **Sequential Execution**: Processes the queue sequentially to maintain browser responsiveness.

### 3.2 State Preservation
- **Media Preservation**: Before refreshing, the extension scans for `<video>` and `<audio>` elements. It attempts to capture their playback state (paused/playing, timestamp) and save it to `sessionStorage` to allow restoration after reload (where supported by the page's logic).

### 3.3 Error Management
- **Robust Error Handling**:
  - Captures refresh failures (e.g., offline, crashed renderer).
  - Implements exponential backoff for retrying failed tabs.
  - Gracefully skips system pages (e.g., `chrome://` URLs) that cannot be scripted.
- **Garbage Collection**: Explicitly hints for garbage collection after batches when run in environments exposing `gc()`.

### 3.4 User Interface
- **Popup Dashboard**:
  - **Start Button**: Single prominent action to initiate process.
  - **Progress Visuals**:
    - Linear progress bar showing percentage complete.
    - Dynamic status text (`Refreshing 5/20 tabs...`).
    - Granular tab list showing status indicators (Loading, Success ✓, Error ✗) for every individual tab.
  - **Visual Feedback**: Confetti animation upon successful completion of all tabs.
- **History Log**: Keeps a local record of the last 10 refresh operations, detailing success rates and timestamps.
- **Error Reporting**:
  - User-opt-in reporting for unhandled exceptions.
  - Detailed view of specific tab errors in the UI.

### 3.5 Developer & QA Features
- **Stress Test Mode** (Hidden):
  - Activated by double-clicking the "Settings" header 5 times.
  - Allows running `N` iterations of the refresh cycle automatically.
  - Stops on error to preserve state for debugging.
- **Debugger Detection**: Monitors for accidental "Paused in debugger" states (common in dev tools) and warns the user with actionable steps to unpause.

## 4. Technical Architecture
- **Manifest Version**: V3
- **Permissions Required**:
  - `tabs`: To query and manipulate tabs.
  - `scripting`: To inject state-preservation scripts.
  - `storage`: To save history and media states.
- **Local Processing**: All logic runs client-side. No user data is sent to external servers unless error reporting is explicitly enabled.

## 5. Non-Functional Requirements
- **Performance**: Must not cause browser "Aw, Snap!" crashes even with 100+ tabs.
- **Responsiveness**: The popup UI must remain responsive during the refresh cycle.
- **Reliability**: Must verify that a tab actually exists before attempting to refresh it, handling race conditions where a user closes a tab mid-process.
