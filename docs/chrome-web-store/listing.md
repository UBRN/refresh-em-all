# Chrome Web Store Listing Proposal

This document contains proposed submission text and a code-backed declaration
audit for Refresh Em All v2.1.0. It does not authorize publication.

v2.1.0 adds English and Turkish localization through Chrome's native
`chrome.i18n` support. Dashboard-only items are tracked separately in
[`dashboard-checklist.md`](dashboard-checklist.md).

## Listing content (English)

**Extension name:** Refresh Em All

**Short description (112 characters):** Reload all accessible tabs in every
window while bypassing the local cache and preserving supported media state.

**Detailed description:**

Refresh Em All performs a cache-bypassing reload of accessible tabs across
every browser window when you click Refresh All Tabs. It is similar in purpose
to a hard refresh such as Command+Shift+R on macOS, applied across your open
tabs.

Each reload bypasses the browser's local cache for that load. Refresh Em All
does not delete cached browsing data or modify cookies, Cache Storage, service
workers, or other site data.

Tabs are processed in small batches to keep the browser responsive. The popup
shows refreshed, failed, and skipped counts. Known browser-internal and
extension pages that cannot be reloaded are skipped; tabs rejected by Chrome
may be reported as failed.

Before reloading a normal accessible page, Refresh Em All attempts to preserve
supported video and audio state, including playback position, play/pause, mute,
volume, and playback rate. Restoration is best effort and depends on the page,
its media player, and Chrome's autoplay rules. Discarded tabs are reloaded
without bringing them to the foreground, but their unloaded media state cannot
be captured first.

The interface is available in English and Turkish, and follows your browser's
language automatically.

Refresh progress and up to ten summary-only history entries remain in
browser-managed storage on your device. Refresh Em All does not send browsing
data, telemetry, analytics, or error reports to the developer or to advertising
or analytics services.

Refresh Em All is open source under the MIT License:
https://github.com/UBRN/refresh-em-all

**Single-purpose statement:** Refresh Em All's single purpose is to perform
cache-bypassing reloads of the user's accessible open tabs across all browser
windows on request, with best-effort preservation of supported audio and video
playback state during the reload.

**Suggested category:** Productivity

## Listing content (Turkish / Türkçe)

Enter this under a **Türkçe** language tab in the Developer Dashboard. Shipping
`_locales/tr` localizes the extension itself; it does **not** localize the Store
listing, which is maintained separately.

**Uzantı adı:** Refresh Em All

**Kısa açıklama (112 karakter):** Bütün pencerelerdeki erişilebilir sekmeleri
yerel önbelleği atlayarak yeniler, desteklenen medya durumunu korur.

**Ayrıntılı açıklama:**

Refresh Em All, "Tüm Sekmeleri Yenile" düğmesine bastığınızda bütün tarayıcı
pencerelerindeki erişilebilir sekmeleri yerel önbelleği atlayarak yeniden
yükler. Yaptığı iş, macOS'ta Command+Shift+R ile yapılan tam yeniden yüklemenin
açık sekmelerinizin tamamına uygulanmış hâline benzer.

Her yenileme o yükleme için tarayıcının yerel önbelleğini atlar. Refresh Em All
önbellekteki gezinme verilerini silmez; çerezlere, Cache Storage'a, service
worker'lara ya da diğer site verilerine dokunmaz.

Sekmeler tarayıcıyı yormamak için küçük gruplar hâlinde işlenir. Açılır pencere
yenilenen, başarısız olan ve atlanan sekme sayılarını gösterir. Yeniden
yüklenemeyen tarayıcı içi sayfalar ve uzantı sayfaları atlanır; Chrome'un yeniden
yükleme isteğini geri çevirdiği sekmeler başarısız olarak bildirilir.

Erişilebilir normal bir sayfayı yenilemeden önce Refresh Em All, desteklenen
video ve ses durumunu korumaya çalışır: oynatma konumu, oynat/duraklat, sessize
alma, ses düzeyi ve oynatma hızı. Bu geri yükleme garanti değildir; sayfaya, medya
oynatıcısına ve Chrome'un otomatik oynatma kurallarına göre değişir. Devre dışı
bırakılmış (bellekten çıkarılmış) sekmeler öne getirilmeden yeniden yüklenir, ama
bu sekmelerin medya durumu önceden okunamaz.

Arayüz İngilizce ve Türkçe olarak sunulur ve tarayıcınızın diline göre kendini
ayarlar.

Yenileme ilerlemesi ve en fazla on adet özet geçmiş kaydı yalnızca cihazınızda,
tarayıcının yönettiği depolamada kalır. Refresh Em All gezinme verisi,
telemetri, analitik veya hata raporu göndermez; ne geliştiriciye ne de reklam
ya da analiz hizmetlerine.

Refresh Em All açık kaynaklıdır ve MIT Lisansı ile dağıtılır:
https://github.com/UBRN/refresh-em-all

**Tek amaç beyanı:** Refresh Em All'ın tek amacı, kullanıcı istediğinde bütün
tarayıcı pencerelerindeki erişilebilir açık sekmeleri yerel önbelleği atlayarak
yeniden yüklemek ve bu sırada desteklenen ses ve video oynatma durumunu
olabildiğince korumaktır.

**Önerilen kategori:** Verimlilik (Productivity)

## Permission justifications and audit

The v2.1.0 manifest declares exactly the same permissions as v2.0.2. Adding
`default_locale` and `__MSG_*__` fields requires no new permission, and no
permission was added or removed in this release.

| Declaration | Current implementation | Necessity and audit result |
| --- | --- | --- |
| `tabs` | `background.js` queries all tabs, gets current tab records, reads URL/title/favicon/status/discarded metadata, and performs cache-bypassing reloads. URLs identify restricted pages; titles and favicons support popup status. | **Used; retain.** The `tabs` permission gates the *fields* `url`, `title`, and `favIconUrl`, not the `query`/`get`/`reload` methods. Removing it hides `tab.url` for exactly the browser-internal pages `<all_urls>` cannot match, so those pages stop being classified as skipped and lose their titles in the popup. See "Permission reduction attempts" below. |
| `scripting` | `background.js` calls `chrome.scripting.executeScript` with the packaged `preserveMediaState` function before reloading an accessible tab, then injects packaged `content-script.js` after that refreshed tab finishes loading when captured media state may exist. | **Used; retain.** Required for best-effort media-state capture and just-in-time restoration in the page. |
| `storage` | The extension uses `chrome.storage.session` for active-operation recovery, `chrome.storage.local` for the ten-entry summary history and legacy cleanup, and `chrome.storage.sync` only to migrate and delete old-version keys. | **Used; retain.** Required for operation continuity, local history, and removal of legacy synced state. |
| Host access / `<all_urls>` | Host permission lets the packaged media-capture function execute on accessible websites before the extension refreshes them, and keeps `url`/`title`/`favIconUrl` readable for ordinary sites. | **Used; retain.** The broad scope matches the disclosed all-tabs purpose. Chrome-controlled and other restricted pages remain inaccessible and are skipped; `file://` access still depends on the user's Chrome setting. |
| Programmatic media restoration | The bundled `content-script.js` is not declared as a permanent content script. After this extension refreshes a tab and that tab reaches `complete`, `background.js` injects the packaged file with `chrome.scripting.executeScript` only when media capture did not report a zero count. | **Used; shipped.** Restoration is scoped to tabs the user just asked the extension to refresh. Existing `scripting` and `<all_urls>` access authorize the injection; the install warning is unchanged. See "Permission reduction attempts". |

No requested permission is unused.

### Permission reduction attempts in this release

Chrome's guidance is to request relevant, least-privilege, and where possible
optional permissions. Both candidates were traced through every caller before
being judged. Candidate 1 is not shipped; Candidate 2 is shipped as a
behavioural least-privilege change, not a permission reduction.

**Candidate 1 — drop `tabs` and rely on `<all_urls>` host permission.**

- *What was tested.* Every `chrome.tabs.*` call site was traced. The only
  sensitive fields consumed are `tab.url` (restricted-page classification in
  `background.js` `isRestrictedTabUrl`), and `tab.title` / `tab.favIconUrl`
  (popup tab indicators, tooltips, accessible names, and the failure list).
- *Precise blocker.* Host permission exposes those fields only for URLs the
  pattern actually matches. `<all_urls>` does **not** match `about:`, `chrome:`,
  `chrome-search:`, `chrome-untrusted:`, `chrome-extension:`, `devtools:`, or
  `edge:` — which is exactly the set the extension classifies as restricted.
  Without `tabs`, those tabs arrive with `url === undefined`,
  `isRestrictedTabUrl(undefined)` returns false, and the tab leaves the skipped
  path entirely. Restricted pages stop being reported as **skipped**, and their
  titles disappear from the popup's indicators and failure list.
- *Evidence, and its limits.* `tests/background.test.js` contains a runnable
  regression test, `reports a tab with no readable URL as reloadable, not
  skipped`, which feeds a tab with `url: undefined` and asserts that no
  `tabSkipped` message is emitted and the reload path runs instead. It sits next
  to the existing `chrome://settings` test that proves correct skip
  classification when the URL *is* readable.
  **What that test does and does not prove:** it proves the classification
  regression — the loss of `tab.url` moves restricted pages off the skipped
  path — which is the user-visible harm. It does **not** prove what Chrome then
  does with the reload request, because `chrome.tabs.reload` is mocked. Whether
  such a reload is rejected, silently ignored, or succeeds was not verified in a
  real browser, so this document makes no claim about it.
- *Smallest future experiment.* Add an opt-in setting that classifies a
  reload rejected with Chrome's "Cannot access" error family as *skipped*
  rather than *failed*, then measure — on a real profile with browser-internal,
  Web Store, and `file://` tabs open — whether that error-shape heuristic
  reproduces today's classification exactly. Only if it matches on every case
  does dropping `tabs` become a candidate, and the popup would still lose
  restricted-tab titles.

**Candidate 2 — remove the permanent all-sites content script and inject the
restoration logic only into tabs this extension just refreshed.**

- *What was shipped.* The full trigger chain was traced:
  `background.js` injects `preserveMediaState` via `chrome.scripting`, which
  writes the `refreshEmAllMediaState` key into the page's `sessionStorage`
  immediately before `chrome.tabs.reload`. If capture does not report a zero
  media count, the worker tracks that tab until `chrome.tabs.onUpdated` reports
  `status === 'complete'`, then injects packaged `content-script.js` once to
  consume the key. Nothing else writes it. The repository contains no
  `chrome.permissions` or `optional_host_permissions` usage today.
- *What this does and does not buy.* Be precise about the benefit, because it
  is easy to overstate. The install warning users see comes from
  `host_permissions: <all_urls>`, which this extension needs and keeps either
  way. Dropping the `content_scripts` declaration therefore does **not** change
  the install warning. The real gain is behavioural: `content-script.js` no
  longer executes at `document_idle` on every navigation on every site for the
  life of the install, and runs only on tabs the user just asked to
  refresh. That is a genuine least-privilege-in-spirit improvement and worth
  doing — it is simply not a permission reduction.
- *Implementation boundary.* The `chrome.tabs.onUpdated` and
  `chrome.tabs.onRemoved` listeners are registered at worker top level, as MV3
  requires. A tab is marked pending only once its cache-bypassing reload has
  been dispatched without error, so an already-loading tab cannot reach
  `complete` for its *previous* navigation and consume the saved key. The mark
  is cleared after one `complete` event or tab removal, and expires after 30
  seconds. The pending set is intentionally held in worker memory; if Chrome
  evicts the MV3 worker between reload and completion, that tab's restoration is
  skipped. That is the remaining race window replacing the previous
  always-declared script.
  Note that `chrome.optional_host_permissions` is **not** the mechanism here —
  `scripting` plus the existing `<all_urls>` host permission is already
  sufficient for programmatic injection, so no runtime consent flow is required.
- *Evidence.* Unit coverage exercises complete/loading events, unrefreshed tabs,
  zero and absent capture results, tab removal, and one-shot injection. The
  existing real-browser reliability scenario remains the integration check for
  paused and playing media across a refresh.

Candidate 1 is not shipped. Candidate 2 removes the permanent
`content_scripts` declaration while retaining every requested permission and
`host_permissions: <all_urls>`; the disclosure and install warning are unchanged.

Note also that removing permissions does **not** earn Enhanced Safe Browsing
publisher trust; see "Trust, badges, and what this release can and cannot
change".

### Reviewer-facing permission text

- **tabs:** Needed to enumerate every open tab, read the URL and display metadata
  required to identify refreshable versus restricted tabs, and perform
  cache-bypassing reloads while reporting local progress.
- **scripting:** Needed to run the extension's packaged media-state capture
  function in an accessible tab immediately before that tab is reloaded and to
  inject packaged `content-script.js` for restoration after that refreshed tab
  finishes loading.
- **storage:** Needed for temporary refresh-operation recovery, up to ten local
  summary history entries, and cleanup of legacy storage created by older
  versions.
- **host access (`<all_urls>`):** Needed because the user-facing purpose is to
  refresh all accessible open tabs, regardless of site, and to capture supported
  media state before those reloads.
- **programmatic media restoration:** Packaged `content-script.js` is injected
  only into a tab this extension just refreshed, after that tab finishes loading.
  It reads only the extension's media-state session key and supported
  media-element properties for this purpose. It is not a permanent
  `content_scripts` declaration and adds no permission.

## Remote-code declaration

Select **No, I am not using remote code**.

All executable extension code is packaged in `background.js`, `popup.js`, and
`content-script.js`. The capture function passed to
`chrome.scripting.executeScript` is defined in the packaged background script;
the restoration call injects packaged `content-script.js` through the API's
`files` option. The extension does not fetch or execute external JavaScript, use
`eval` or `new Function`, import remote modules, or load a remote script. The
`_locales/*/messages.json` catalogs are data, not code, and are read by Chrome's
own `chrome.i18n` implementation.

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

Localization changes nothing here: the catalogs are static text shipped in the
package, and selecting a locale reads the browser UI language through
`chrome.i18n` without collecting or transmitting anything.

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

- **Homepage URL:** `https://github.com/UBRN/refresh-em-all`
- **Support URL:** `https://github.com/UBRN/refresh-em-all/issues`
- **Privacy policy URL:** `https://github.com/UBRN/refresh-em-all/blob/main/PRIVACY.md`
- **Support email:** not set in this repository. A real, monitored address must
  be entered in the Developer Dashboard before submission — this release does
  not invent one. Featured nomination requires support in English, so the
  address has to be one somebody actually reads. Tracked in
  [`dashboard-checklist.md`](dashboard-checklist.md) §6.
- **Privacy contact:** Public repository issue tracker, unless the publisher
  supplies a dedicated monitored privacy contact before submission.

Do not add Chrome Web Store credentials, API keys, client secrets, or realistic
secret placeholders to the repository.

## Trust, badges, and what this release can and cannot change

These three things are frequently confused. They are separate systems with
separate criteria, and none of them is granted by this release.

**Enhanced Safe Browsing trust.** Chrome warns users who have Enhanced Safe
Browsing enabled about extensions that are not yet trusted. An extension becomes
trusted once its developer has followed the Chrome Web Store Developer Program
Policies for a sustained period — it is a function of **publisher history**, not
of package contents. A new developer typically waits **several months**. Nothing
in a release accelerates it: not reducing permissions, not localization, not
better screenshots. Removing permissions for this purpose would be
cargo-culting, and this release does not do it.

**Established Publisher badge.** Awarded to publishers who have verified their
identity with Google and maintained a compliance record in good standing. It is
about the publisher account, not about any single item. Review of the current
nomination form also indicates a **verified related website** is required before
the badge appears, so verifying site ownership is worth doing early.

**Featured badge.** Applied by the Chrome Web Store team after a **manual**
review for adherence to Store best practices — technical quality, a genuinely
useful and self-evident user experience, accurate and complete listing metadata,
and quality visual assets. Eligibility is a precondition, not a promise.

### Featured nomination prerequisites

Recorded from the nomination form as it stood when this release was prepared.
Re-read the live form before submitting; Google edits it without notice.

- The extension is owned by the publisher making the nomination.
- Support is offered in English.
- The extension is published and its visibility is Public.
- There are no active policy violations against the item.
- Core functionality is available without requiring credentials or payment.

Review of the live form during this release surfaced two further criteria that
are **not** in the list above and should be confirmed before submitting: the
extension must be broadly relevant to users rather than niche, and an item may
only be nominated once in a given period (reported as six months). Treat the
live form as authoritative over both lists.

Refresh Em All satisfies the credential-free criterion in code — the popup's refresh action needs
no account, no login, and no payment. Every other item is an account or
dashboard fact that cannot be verified from this repository.

### Nomination step

Featured nomination is manual. After the public v2.1.0 version is live and
stable, submit it through **One Stop Support** in the Developer Dashboard. There
is no API and no automatic nomination.

**Featured evaluation is manual, discretionary, and not guaranteed.** This
release produces a verified candidate. It does not earn, and must not be
described as earning, the badge.

## Visual assets

The reviewed listing assets and their reproducible sources live under
`docs/chrome-web-store/assets/`. They are documentation-only Store inputs and
are not included in the extension package.

- The deterministic v2.1.0 package is `refresh-em-all-v2.1.0.zip`, **111,659
  bytes**, with SHA-256
  `b7c1459f5263afca94e54add6458f5e15531f239e31b09e76b7c8805d46b56d5`.
  It contains 17 entries, including `_locales/en/messages.json` and
  `_locales/tr/messages.json`. Rebuilding it reproduces the same SHA-256.
- All ten 1280×800 screenshots were captured from that exact ZIP, after the
  capture script verified the above SHA-256 and that the loaded extension
  reported version 2.1.0.
  - English: `assets/screenshots/*.png` (5 files)
  - Turkish: `assets/screenshots/tr/*.png` (5 files)
- Each capture run also asserts the popup's resolved `@@ui_locale` matches the
  requested locale, so a Turkish set cannot silently be an English one. Asset
  validation additionally rejects duplicate images across locales.
- The screenshots show the ready, in-progress, completed, history, and privacy
  settings states using neutral localhost fixtures and an isolated browser
  profile. Browser chrome, URLs, personal data, local paths, DevTools,
  automation banners, and test identifiers are excluded.
- Measured popup geometry is identical in both locales at 372×217–349 CSS px
  inside a 640×400 viewport, with no horizontal overflow, so the longer Turkish
  strings fit the 350 px popup without clipping.
- The required 440×280 promotional PNG is rendered from a self-contained SVG
  source with repository-local tooling and no external fonts or images.
- The packaged 128×128 icon remains unchanged for v2.1.0. Its opaque padding is
  documented as a possible future improvement; correcting it would require a
  separately scoped package version rather than replacing a published ZIP.

See `docs/chrome-web-store/assets/README.md` for provenance, commands, output
dimensions, and review constraints.

## Submission checklist

Repository-verifiable items are ticked only where this release actually verified
them. Dashboard-only items live in
[`dashboard-checklist.md`](dashboard-checklist.md) and are **not** ticked here.

- [x] Regenerate five 1280×800 English PNG screenshots from the verified v2.1.0
      package, showing the popup before, during, and after a refresh plus local
      history and privacy settings. Human visual approval is still required.
- [x] Generate the matching five Turkish 1280×800 screenshots from the same
      verified package with a Turkish browser UI locale. Human visual approval
      is still required.
- [x] Generate the required 440×280 PNG promotional image from its repository
      SVG source. Human visual approval is still required.
- [x] Validate the packaged 128×128 icon against current Store guidance. It is
      a valid, exact-size PNG but uses opaque rather than transparent padding;
      retain it unchanged for v2.1.0 and treat transparency as a future package
      improvement.
- [x] Confirm the package contains both locale catalogs and nothing undeclared.
      The packaging allowlist now fails closed on an undeclared locale, a stray
      file inside `_locales/`, or a missing default-locale catalog.
- [ ] Select **Productivity** and confirm the extension name and descriptions in
      both English and Turkish.
- [ ] Enter each permission justification exactly consistently with the uploaded
      manifest and this audit.
- [ ] Select **No, I am not using remote code**.
- [ ] Declare **Web history** and **Website content**, complete the Limited Use
      certifications, and confirm no unsupported data category is selected.
- [ ] Add reviewer notes explaining that refresh begins only after the user
      clicks **Refresh All Tabs**, each actual reload bypasses local cache,
      cached browsing data and site data are not deleted, restricted pages are
      skipped, media restoration is best effort, the all-sites content script
      exits when no saved state is present, the interface is localized with
      Chrome's built-in `chrome.i18n` using packaged static catalogs, and no
      remote code or external reporting endpoint exists.
- [ ] Upload the verified `refresh-em-all-v2.1.0.zip` only after confirming its
      SHA-256 is
      `b7c1459f5263afca94e54add6458f5e15531f239e31b09e76b7c8805d46b56d5`.
- [ ] Work through [`dashboard-checklist.md`](dashboard-checklist.md) in full.
- [ ] Review the current Chrome Web Store dashboard wording immediately before
      submission because policy labels and required fields can change.
- [ ] Do not publish until every listing, privacy, asset, support, distribution,
      and reviewer-note field has been manually reviewed by the publisher.
