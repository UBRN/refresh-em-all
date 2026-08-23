# Privacy Policy

Effective date: August 24, 2026

Refresh Em All refreshes open tabs and attempts to preserve supported audio and
video playback state. The extension performs this work locally in Chrome. The
developer does not receive the tab, page, media, refresh, or error information
described below.

Each requested tab reload bypasses local cache for that reload. This does not
delete cached browsing data or modify cookies, Cache Storage, service workers,
or other site data.

## Information handled by the extension

To perform a refresh, Chrome provides the extension with information about open
tabs. A tab record can include its tab and window identifiers, URL, title,
favicon URL, loading status, discarded status, audible state, and other tab
metadata supplied by the Chrome Tabs API. Refresh Em All uses this information
to identify refreshable tabs, avoid restricted browser pages, refresh tabs, and
show progress in the popup.

Before reloading an accessible page, the extension checks its video and audio
elements. It may temporarily handle the media source URL, current playback
position, paused or playing state, muted state, volume, and playback rate. On
YouTube pages it may also handle the current video identifier and the time at
which state was captured. The extension does not read arbitrary page text or
form contents for this feature.

The same pre-reload check also reads the page's Resource Timing entries to
total the byte sizes of resources the page loaded from cache. It reads only
sizes and timings recorded by the browser, not page content, text, or URLs
beyond those already described above.

## Local storage and retention

Refresh Em All uses the following browser-managed storage:

- `chrome.storage.session` temporarily holds the active refresh-operation
  snapshot. This can include the current tab records, progress, per-tab status,
  and local failure details. The extension removes this snapshot when an
  operation finishes. If Chrome interrupts the operation, the snapshot is used
  only to report that interruption and remains session-scoped.
- `chrome.storage.local` holds at most ten refresh-history summaries. Each
  summary contains a timestamp, tab totals, successful, failed, and skipped
  counts, and whether the operation was cancelled. History summaries do not
  contain tab URLs or titles.
- `chrome.storage.local` also holds `cacheStats`, which contains byte totals
  only: the most recent operation, an all-time total, and at most 31 daily
  totals keyed by local date. It contains no URLs, hostnames, per-site, or
  per-tab data. The reset control in the popup clears it.
- The relevant page's `sessionStorage` temporarily holds media state under the
  `refreshEmAllMediaState` key so it can survive that page's reload. The bundled
  content script removes the entry when it reads it. If it cannot be consumed,
  the entry remains limited to that page's session and origin and expires with
  the page session.

Current versions do not write refresh information to Chrome Sync. To clean up
data created by older versions, the extension checks for legacy refresh history
and error-reporting consent in `chrome.storage.sync`, copies at most ten
sanitized history summaries to local storage when needed, and removes the
legacy sync keys. It also removes any legacy pending-error-report data from
local extension storage.

## Error handling, analytics, and transmission

Errors are handled locally through the extension popup and browser developer
console. Refresh Em All does not send error reports, telemetry, analytics,
browsing activity, tab information, or media state to the developer or to an
analytics or advertising service. It has no developer-operated data endpoint.

The popup can display a favicon URL supplied by Chrome for an open tab. Chrome
may load or reuse that icon from the site that provides it; Refresh Em All does
not attach its stored refresh, media, or error information to that request.

Refresh Em All does not sell user data, share it for advertising, use it for
creditworthiness or lending, or use it to build profiles. No developer or third
party is given access to the locally handled data.

## Remote code

Refresh Em All does not execute remote code. All JavaScript executed by the
extension, including code used to preserve and restore media state, is included
in the installed extension package.

## Deletion

Removing Refresh Em All removes storage controlled by the extension. Media
entries in page `sessionStorage` are temporary, scoped to the relevant page
session and origin, and are normally removed immediately after they are read
following a reload.

## Chrome Web Store Limited Use

The use of information received from Chrome APIs adheres to the Chrome Web
Store User Data Policy, including the Limited Use requirements. Refresh Em All
uses that information only to provide its single purpose: refreshing the user's
open tabs and preserving supported media playback state during that refresh.

## Contact

For privacy questions, file an issue in the
[Refresh Em All repository](https://github.com/UBRN/refresh-em-all/issues).
