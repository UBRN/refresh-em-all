# Chrome Web Store Listing Proposal

This document contains proposed submission text and a code-backed declaration
audit for Refresh Em All v2.0.1. It does not authorize publication.

## Listing content

**Extension name:** Refresh Em All

**Short description:** Refresh every open tab across all browser windows with
one click while preserving supported media playback state.

**Detailed description:**

Refresh Em All refreshes all accessible tabs in every browser window when you
click its refresh button. Tabs are processed in small batches, and the popup
shows refreshed, failed, and skipped counts. Browser-internal and other
restricted pages that Chrome extensions cannot access are skipped.

Before reloading an accessible page, Refresh Em All attempts to preserve the
state of its video and audio elements. Supported playback position, play/pause,
mute, volume, and playback-rate state is restored after reload when the page and
Chrome's autoplay rules allow it. Refresh progress and up to ten summary-only
history entries stay in browser-managed storage on the user's device.

All extension logic is included in the installed package. Refresh Em All does
not send browsing data, telemetry, analytics, or error reports to the developer
or an analytics or advertising service.

**Single-purpose statement:** Refresh Em All's single purpose is to refresh the
user's open tabs across all browser windows on request, with best-effort
preservation of supported audio and video playback state during the reload.

**Suggested category:** Productivity

## Permission justifications and audit

| Declaration | Current implementation | Necessity and audit result |
| --- | --- | --- |
| `tabs` | `background.js` queries all tabs, gets current tab records, reads URL/title/favicon/status/discarded metadata, and reloads tabs. URLs identify restricted pages; titles and favicons support popup status. | **Used; retain.** Reloading alone does not require this permission, but the sensitive tab fields do. `<all_urls>` does not cover every enumerated browser-internal tab, so removal would change restricted-tab classification and popup behavior. |
| `scripting` | `background.js` calls `chrome.scripting.executeScript` with the packaged `preserveMediaState` function before reloading an accessible tab. | **Used; retain.** Required for best-effort media-state capture in the page. |
| `storage` | The extension uses `chrome.storage.session` for active-operation recovery, `chrome.storage.local` for the ten-entry summary history and legacy cleanup, and `chrome.storage.sync` only to migrate and delete old-version keys. | **Used; retain.** Required for operation continuity, local history, and removal of legacy synced state. |
| Host access / `<all_urls>` | Host permission lets the packaged media-capture function execute on accessible websites before the extension refreshes them. | **Used; retain.** The broad scope matches the disclosed all-tabs purpose. Chrome-controlled and other restricted pages remain inaccessible and are skipped; `file://` access still depends on the user's Chrome setting. |
| Content scripts / `<all_urls>` | The bundled `content-script.js` runs at `document_idle` on matching page loads. It checks for the extension's page-session media key, exits when none exists, and restores and removes saved state after a refresh. | **Used; retain.** Matching all accessible sites is necessary to restore state after refreshing arbitrary tabs. This declaration is separate from host permission and can also produce an installation warning. |

No requested permission is unused. No permission should be removed without new
browser-level equivalence evidence and the complete test matrix passing with
identical user-visible behavior.

### Reviewer-facing permission text

- **tabs:** Needed to enumerate every open tab, read the URL and display metadata
  required to identify refreshable versus restricted tabs, and reload tabs while
  reporting local progress.
- **scripting:** Needed to run the extension's packaged media-state capture
  function in an accessible tab immediately before that tab is reloaded.
- **storage:** Needed for temporary refresh-operation recovery, up to ten local
  summary history entries, and cleanup of legacy storage created by older
  versions.
- **host access (`<all_urls>`):** Needed because the user-facing purpose is to
  refresh all accessible open tabs, regardless of site, and to capture supported
  media state before those reloads.
- **content scripts (`<all_urls>`):** Needed to run the packaged restoration logic
  after a refreshed page loads. The script reads only the extension's media-state
  session key and supported media-element properties for this purpose.

## Remote-code declaration

Select **No, I am not using remote code**.

All executable extension code is packaged in `background.js`, `popup.js`, and
`content-script.js`. The function passed to `chrome.scripting.executeScript` is
defined in the packaged background script. The extension does not fetch or
execute external JavaScript, use `eval` or `new Function`, import remote modules,
or load a remote script.

## Data-use declaration guidance

Chrome Web Store policy treats locally processed data as data handling. The
dashboard declarations, privacy-policy URL, listing, and runtime behavior must
remain consistent.

Declare these categories:

- **Web history:** Open-tab URLs and titles are processed locally to identify and
  refresh tabs. The extension does not build or transmit a browsing-history log.
- **Website content:** Supported audio/video element properties, media source
  URLs, and the extension's media-state value in page `sessionStorage` are
  processed locally to preserve playback state across a refresh.

Do not declare personally identifiable information, health information,
financial/payment information, authentication information, personal
communications, location, user-generated content, or general user activity;
the current implementation does not handle those categories for its purpose.

Certify that handled data:

- is used only to provide the extension's disclosed single purpose;
- is not sold or transferred to the developer, data brokers, advertisers, or
  other services;
- is not used for advertising, profiling, creditworthiness, or lending;
- is not made available for human review; and
- is not transmitted to developer-operated telemetry, analytics, or error
  reporting endpoints.

The popup displays Chrome-provided favicons. Chrome may load or reuse an icon
from its source site, but the extension does not attach stored tab, media,
history, or error records to that request.

## Support information

- **Support URL:** `TODO: add the public support page or repository-issues URL`
- **Support email:** `TODO: add the monitored publisher support email in the dashboard`
- **Privacy contact:** Public repository issue tracker, unless the publisher
  supplies a dedicated monitored privacy contact before submission.

Do not add Chrome Web Store credentials, API keys, client secrets, or realistic
secret placeholders to the repository.

## Submission checklist

- [ ] Capture at least one clear 1280×800 or 640×400 PNG/JPEG screenshot showing
      the popup before and after a refresh; remove unrelated personal tab data.
- [ ] Create and review the required 440×280 PNG/JPEG promotional image. The
      existing 1200×600 repository hero image is not the required size.
- [ ] Validate the packaged 128×128 icon against current Store guidance,
      including the recommended 96×96 artwork area and transparent padding. The
      current 128×128 PNG is opaque, so resolve that risk in a separately scoped
      version if the Store rejects it; changing it would change the v2.0.1 ZIP.
- [ ] After this change merges, use the public policy URL:
      `https://github.com/UBRN/refresh-em-all/blob/main/PRIVACY.md`.
- [ ] Fill in and verify the monitored support URL and support email.
- [ ] Select **Productivity** and confirm the extension name and descriptions.
- [ ] Select **Public** visibility and all intended distribution regions, unless
      the publisher has a documented reason to limit distribution.
- [ ] Enter each permission justification exactly consistently with the uploaded
      manifest and this audit.
- [ ] Select **No, I am not using remote code**.
- [ ] Declare **Web history** and **Website content**, complete the Limited Use
      certifications, and confirm no unsupported data category is selected.
- [ ] Add reviewer notes explaining that refresh begins only after the user
      clicks **Refresh All Tabs**, restricted pages are skipped, media restoration
      is best effort, the all-sites content script exits when no saved state is
      present, and no remote code or external reporting endpoint exists.
- [ ] Upload the verified `refresh-em-all-v2.0.1.zip` only after confirming its
      SHA-256 is
      `dae27e545bea8b27f842657781ff8fc172c5ccc431e7650357c6098e74f9954d`.
- [ ] Review the current Chrome Web Store dashboard wording immediately before
      submission because policy labels and required fields can change.
- [ ] Do not publish until every listing, privacy, asset, support, distribution,
      and reviewer-note field has been manually reviewed by the publisher.
