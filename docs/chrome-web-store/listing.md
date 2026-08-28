# Chrome Web Store Listing Proposal

This document contains proposed submission text and a code-backed declaration
audit for Refresh Em All v2.4.4. It does not authorize publication.

v2.4.4 is a packaging release. The Store icon declared in `manifest.json`
`icons` moves from the monochrome set to the colorful set the toolbar already
used, so the listing, the extensions page, and the toolbar now show one
artwork. The monochrome files are no longer referenced and no longer ship. It
changes no permission, no interface, and no data handling.

The permission model below is unchanged since v2.4.2, which made all-sites host
access optional and requested it at runtime for media preservation and cache
measurement. Refreshing continues without that grant. Dashboard-only items are tracked separately in
[`dashboard-checklist.md`](dashboard-checklist.md).

## Listing content (English)

**Extension name:** Refresh Em All

**Short description (106 characters):** Reload every tab in all your windows
and fetch fresh files instead of reusing copies Chrome saved earlier.

**Detailed description:**

Refresh Em All reloads the tabs it can reload across every browser window when
you click Refresh All Tabs. Each reload asks Chrome to fetch fresh files instead
of reusing the copies Chrome saved earlier.

This does not delete cached browsing data or free disk space. It does not
modify cookies, Cache Storage, service workers, or other site data.

Refresh Em All handles a few tabs at a time to keep Chrome responsive. The
popup shows how many reload requests Chrome accepted and how many tabs failed
or were skipped. Accepted means Chrome accepted the reload request; it does not
mean the page finished loading. Chrome's own pages, which no extension can
reload, and other extension pages are skipped. Other tabs Chrome rejects are
reported as failed.

Before reloading a normal page, Refresh Em All tries to keep videos and audio
where you left them. This includes playback position, play or pause, mute,
volume, and playback rate. Restoration is best effort and depends on the page,
its media player, and Chrome's autoplay rules. Sleeping tabs reload without
coming to the foreground, but their unloaded media cannot be checked first.

The interface is available in English and Turkish, and follows your browser's
language automatically.

With optional all-sites access granted, the extension's injected capture
function reads the page's Resource Timing entries before each reload. It adds
`encodedBodySize` only for entries where `transferSize === 0` and
`decodedBodySize > 0`, meaning the browser served the resource from cache. The
function returns one byte count per tab. No resource URL, resource name, or
timing value leaves the page.

The background worker combines those per-tab numbers into one total for the
run. On completion it stores the local `cacheStats` counter as `{ lastRun,
total, days: { "YYYY-MM-DD": bytes } }`, pruning `days` to the most recent 31
dates. The popup reports at least the amount found for the last run, today, the
last 7 days, the last 30 days, and all time. The counter is not tied to an
identifier and is never sent anywhere.

These figures do not say how much cache was deleted or how much disk space was
freed. They show files that were served from saved copies and will now be
downloaded again.

Every figure says "at least" because some files do not tell the page their
size, so they are not counted. Chrome also keeps only a limited number of load
records for a page, 250 by default, and Refresh Em All does not raise that
limit. When either limit applies, the real number is higher. You can reset the
totals from Settings.

Keeping videos and audio where you left them and measuring these files require
permission to read the pages you refresh. Without that permission, Refresh Em
All still reloads your tabs and fetches fresh files instead of reusing saved
copies. No measurement runs, and the popup says page access is unavailable. The
last-run figure becomes at least 0 bytes, while the last 7 days and last 30 days
keep changing as older days fall outside those periods.

While a refresh is running, Chrome's memory-backed, nonsynced session storage
holds a temporary snapshot under `refreshOperationState`. It contains the tab
objects in the run, including tab IDs, URLs, titles, favicon URLs, and per-tab
status, with the same tab details for failures. This lets the popup redraw the
run and lets the operation resume after a Manifest V3 service worker eviction.
It is never exposed to web pages. Chrome discards it when the browser session
ends, and Refresh Em All removes it when the operation finishes.

Durable `refreshHistory` storage keeps at most ten counts-only summaries:
timestamp, total tabs, successful tabs, failed count, skipped count, and the
cancelled flag. It contains no URLs, titles, or favicons. Refresh Em All sends
no tab details, cache counters, history, telemetry, or error reports anywhere,
and it uses no remote code.

Refresh Em All is open source under the MIT License:
https://github.com/UBRN/refresh-em-all

The progress display, counts-only run history, cached-bytes counter, and media
position restoration support this reload workflow.

**Single-purpose statement:** Refresh Em All's single purpose is reloading the
user's open tabs while bypassing the local HTTP cache.

**Suggested category:** Productivity

## Listing content (Turkish / Türkçe)

Enter this under a **Türkçe** language tab in the Developer Dashboard. Shipping
`_locales/tr` localizes the extension itself; it does **not** localize the Store
listing, which is maintained separately.

**Uzantı adı:** Refresh Em All

**Kısa açıklama (102 karakter):** Bütün pencerelerdeki sekmeleri tek tıkla
yeniler; kayıtlı kopyalar yerine dosyaların yenisini indirir.

**Ayrıntılı açıklama:**

Refresh Em All, "Tüm Sekmeleri Yenile" düğmesine bastığınızda Chrome'un yeniden
yükleyebildiği sekmeleri bütün pencerelerde yeniden yükler. Her yeniden
yüklemede Chrome'dan daha önce kaydettiği kopyaları kullanmak yerine dosyaları
yeniden indirmesini ister.

Bu işlem önbellekteki gezinme verilerini silmez veya diskte yer açmaz. Çerezlere,
Cache Storage'a, service worker'lara ya da diğer site verilerine dokunmaz.

Refresh Em All, Chrome'u yormamak için bir seferde birkaç sekmeyi işler. Açılır
pencere Chrome'un kaç yeniden yükleme isteğini kabul ettiğini, kaç sekmenin
başarısız olduğunu ve kaç sekmenin atlandığını gösterir. Başarılı sayılması
yalnızca Chrome'un isteği kabul ettiği anlamına gelir; sayfanın yüklenmeyi
bitirdiği anlamına gelmez. Chrome'un kendi sayfalarını hiçbir uzantı yeniden
yükleyemez. Bunlar ve diğer uzantı sayfaları atlanır. Chrome'un geri çevirdiği
diğer sekmeler başarısız sayılır.

Refresh Em All normal bir sayfayı yeniden yüklemeden önce videoları ve sesleri
bıraktığınız yerde tutmaya çalışır. Buna oynatma konumu, oynatma veya duraklatma,
sessize alma, ses düzeyi ve oynatma hızı dahildir. Bu geri yükleme için elinden
geleni yapar; sonuç sayfaya, medya oynatıcısına ve Chrome'un otomatik oynatma
kurallarına bağlıdır. Uyuyan sekmeler öne getirilmeden yeniden yüklenir, ancak
henüz yüklenmemiş medyaları önceden denetlenemez.

Arayüz İngilizce ve Türkçe olarak sunulur ve tarayıcınızın diline göre kendini
ayarlar.

İsteğe bağlı tüm sitelere erişim verildiğinde uzantının sayfaya eklediği yakalama
işlevi, her yeniden yüklemeden önce sayfanın Resource Timing kayıtlarını okur.
Yalnızca `transferSize === 0` ve `decodedBodySize > 0` olan kayıtlardaki
`encodedBodySize` değerlerini toplar. Bunlar tarayıcının önbellekten sunduğu
kaynaklardır. İşlev her sekme için yalnızca bir bayt değeri döndürür; kaynak URL'si,
kaynak adı veya zamanlama değeri sayfadan çıkmaz.

Arka plan worker'ı sekme değerlerini tek bir çalışma toplamında birleştirir.
Çalışma bitince yerel `cacheStats` sayacını `{ lastRun, total, days: {
"YYYY-MM-DD": bytes } }` biçiminde yazar ve `days` alanını en yeni 31 tarihle
sınırlar. Açılır penceredeki her değer en az miktarı gösterir: son çalıştırma,
bugün, son 7 gün, son 30 gün ve tüm zamanlar. Sayaç hiçbir tanımlayıcıyla
ilişkilendirilmez ve hiçbir yere gönderilmez.

Bu değerler önbellekten ne kadar veri silindiğini veya diskte ne kadar yer
açıldığını göstermez. Daha önce kaydedilmiş kopyalardan sunulan ve şimdi yeniden
indirilecek dosyaları gösterir.

Her değerde "en az" yazar. Çünkü bazı dosyalar boyutlarını sayfaya bildirmez ve
hesaba katılmaz. Chrome ayrıca bir sayfa için sınırlı sayıda yükleme kaydı tutar;
varsayılan sınır 250'dir ve Refresh Em All bu sınırı artırmaz. Bu sınırlardan
biri devreye girdiğinde gerçek miktar daha yüksektir. Toplamları Ayarlar'dan
sıfırlayabilirsiniz.

Videoları ve sesleri bıraktığınız yerde tutmak ve bu dosyaları ölçmek,
yenilediğiniz sayfaları okuma izni gerektirir. İzin vermezseniz Refresh Em All
sekmelerinizi yine yeniden yükler ve Chrome'un daha önce kaydettiği kopyaları
kullanmak yerine dosyaları yeniden indirir. Ölçüm yapılmaz ve açılır pencere
sayfa erişiminin bulunmadığını bildirir. Son çalıştırma değeri en az 0 bayt olur;
eski günler dönem dışına çıktıkça son 7 ve son 30 gün değerleri değişmeye devam
eder.

Yenileme sürerken Chrome'un bellekte tutulan ve eşitlenmeyen oturum depolaması,
`refreshOperationState` anahtarında geçici bir anlık görüntü saklar. Bu görüntü;
çalışmadaki sekmelerin kimliklerini, URL'lerini, başlıklarını, favicon URL'lerini,
sekme başına durumu ve başarısız sekmeler için aynı ayrıntıları içerir. Açılır
pencerenin çalışmayı yeniden çizmesini ve Manifest V3 service worker'ı bellekten
çıkarıldığında işlemin sürdürülmesini sağlar. Web sayfalarına açılmaz. Chrome
tarayıcı oturumu bitince siler, Refresh Em All ise işlem bitince kaldırır.

Kalıcı `refreshHistory` depolaması en fazla on adet yalnızca sayı içeren özet
tutar: zaman damgası, toplam sekme, başarılı sekme, başarısız sayısı, atlanan
sayısı ve iptal durumu. URL, başlık veya favicon içermez. Refresh Em All sekme
ayrıntılarını, önbellek sayaçlarını, geçmişi, telemetriyi veya hata raporlarını
hiçbir yere göndermez ve uzak kod kullanmaz.

Refresh Em All açık kaynaklıdır ve MIT Lisansı ile dağıtılır:
https://github.com/UBRN/refresh-em-all

İlerleme göstergesi, yalnızca sayılardan oluşan çalışma geçmişi, önbellekten
sunulan bayt sayacı ve medya konumu geri yükleme bu yenileme akışını destekler.

**Tek amaç beyanı:** Refresh Em All'ın tek amacı, kullanıcının açık sekmelerini
yerel HTTP önbelleğini atlayarak yeniden yüklemektir.

**Önerilen kategori:** Verimlilik (Productivity)

## Permission justifications and audit

The v2.4.4 manifest keeps `tabs`, `scripting`, and `storage` required while
moving `<all_urls>` from `host_permissions` to `optional_host_permissions`.
The popup requests that host access at runtime; refusing it does not prevent
cache-bypassing tab reloads.

| Declaration | Current implementation | Necessity and audit result |
| --- | --- | --- |
| `tabs` | `background.js` enumerates every open tab across all windows and reads tab URL and status. The URL is used to identify restricted pages such as `chrome:`, `chrome-extension:`, and `devtools:` so they are skipped instead of failing. | **Used; retain.** The `tabs` permission exposes the URL needed for restricted-page classification. Removing it hides `tab.url` for browser-internal pages `<all_urls>` cannot match, so those pages leave the skipped path. See "Permission reduction attempts" below. |
| `scripting` | When optional host access is granted, `background.js` injects the packaged capture function before reload and packaged `content-script.js` for restoration afterward, only in tabs the user granted access to. | **Used; retain.** It supports media-position restoration and cached-bytes measurement for the reload. It is not used when host access is absent. |
| `storage` | `chrome.storage.session` holds the temporary operation snapshot. `chrome.storage.local` holds the counts-only ten-entry history and the aggregate cached-bytes counter. | **Used; retain.** Required to redraw or resume an active reload, show summary history, and show the local cached-bytes counter. |
| Host access / `<all_urls>` | Declared in `optional_host_permissions` and requested from the popup at runtime. It authorizes only packaged media capture/restoration and the cache measurement introduced in v2.3.0 on accessible websites. | **Optional; request at runtime.** A refusal leaves cache-bypassing refresh fully operational. Media preservation stops, no measurement runs, and the popup reports that access is unavailable. Chrome-controlled and other restricted pages remain inaccessible and are skipped; `file://` access still depends on the user's Chrome setting. |
| Programmatic media restoration | The bundled `content-script.js` is not declared as a permanent content script. When optional host access is present, `background.js` injects it only after a tab this extension refreshed reaches `complete` and media capture may have saved state. | **Used only with optional host access.** Without the grant, the worker goes directly to a cache-bypassing reload and performs no page injection. |

No required permission is unused. Media restoration and cache measurement under
the optional host permission support the single cache-bypassing reload purpose.

### Permission reduction attempts in this release

Chrome's guidance is to request relevant, least-privilege, and where possible
optional permissions. v2.4.4 ships the all-sites host permission as optional,
while retaining `tabs` for the separate restricted-page classification and
display-metadata behavior established by Candidate 1.

**Shipped change: move `<all_urls>` to runtime-requested optional host
access.**

- *Manifest and prompt.* `<all_urls>` moves from `host_permissions` to
  `optional_host_permissions`. A fresh install begins with no granted origins.
  The popup requests access directly inside the user's first Refresh All Tabs
  click and records that it has asked, so it never prompts automatically twice.
  Settings keeps a permanent user-triggered way to request access later.
- *Behavior without access.* The worker resolves permission once at the start
  of each operation. Without access it performs the same cache-bypassing reloads
  and does not attempt page injection. Media-state preservation stops and no
  new page data is measured; cache statistics still record a normal last-run
  value of zero, and rolling windows continue to change as days age out.
  Refusing access never cancels the refresh.
- *Fresh-install warning.* With required `<all_urls>` removed, the install
  warning drops from "Read and change all your data on all websites" to the
  `tabs` warning, "Read your browsing history." It does not disappear because
  Candidate 1's analysis below is precisely why `tabs` remains required.
- *Upgrade evidence and limit.* An unpacked extension was upgraded in place on
  the same profile and extension ID from required to optional host access. Its
  existing `<all_urls>` grant survived, and the service worker remained active.
  This is evidence for an unpacked in-place upgrade, **not** a Chrome Web Store
  update. Independently, the
  [Chromium extensions permissions design](https://chromium.googlesource.com/chromium/src/+/HEAD/extensions/docs/permissions.md)
  documents that the granted permission set survives removal from the active
  manifest set and that update disabling compares requested permissions with
  the granted set. Together these support, but do not mislabel, the upgrade
  conclusion.

**Candidate 1: drop `tabs` and rely on `<all_urls>` host permission.**

- *What was tested.* Every `chrome.tabs.*` call site was traced. The only
  sensitive fields consumed are `tab.url` (restricted-page classification in
  `background.js` `isRestrictedTabUrl`), and `tab.title` / `tab.favIconUrl`
  (popup tab indicators, tooltips, accessible names, and the failure list).
- *Precise blocker.* Host permission exposes those fields only for URLs the
  pattern actually matches. `<all_urls>` does **not** match `about:`, `chrome:`,
  `chrome-search:`, `chrome-untrusted:`, `chrome-extension:`, `devtools:`, or
  `edge:`, which is exactly the set the extension classifies as restricted.
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
  regression: the loss of `tab.url` moves restricted pages off the skipped
  path, which is the user-visible harm. It does **not** prove what Chrome then
  does with the reload request, because `chrome.tabs.reload` is mocked. Whether
  such a reload is rejected, silently ignored, or succeeds was not verified in a
  real browser, so this document makes no claim about it.
- *Smallest future experiment.* Add an opt-in setting that classifies a
  reload rejected with Chrome's "Cannot access" error family as *skipped*
  rather than *failed*, then measure (on a real profile with browser-internal,
  Web Store, and `file://` tabs open) whether that error-shape heuristic
  reproduces today's classification exactly. Only if it matches on every case
  does dropping `tabs` become a candidate, and the popup would still lose
  restricted-tab titles.

**Candidate 2: keep restoration programmatic rather than permanent.**

- *What remains shipped.* The full trigger chain is unchanged when optional
  host access is granted:
  `background.js` injects `preserveMediaState` via `chrome.scripting`, which
  writes the `refreshEmAllMediaState` key into the page's `sessionStorage`
  immediately before `chrome.tabs.reload`. If capture does not report a zero
  media count, the worker tracks that tab until `chrome.tabs.onUpdated` reports
  `status === 'complete'`, then injects packaged `content-script.js` once to
  consume the key. Nothing else writes it. Without host access, neither capture
  nor restoration injection is attempted.
- *What this buys.* `content-script.js` does not execute at `document_idle` on
  every navigation. With access granted it runs only on tabs the user just
  asked to refresh; without access it does not run at all. v2.4.4's optional
  host declaration is the mechanism that removes the broad install-time host
  warning while preserving this programmatic design after consent.
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
- *Evidence.* Unit coverage exercises granted and denied host-access paths,
  complete/loading events, unrefreshed tabs, zero and absent capture results,
  tab removal, and one-shot injection. The real-browser reliability scenario
  seeds an existing-user grant through an unpacked in-place upgrade before
  checking paused and playing media restoration. A separate fresh-profile
  scenario checks that no-grant refreshes complete without media restoration.

Candidate 1 is not shipped, so the `tabs` warning remains. Candidate 2 remains
the restoration model. v2.4.2 changes required all-sites host access into an
optional runtime grant and keeps basic refreshing available without it.

Note also that removing permissions does **not** earn Enhanced Safe Browsing
publisher trust; see "Trust, badges, and what this release can and cannot
change".

### Reviewer-facing permission text

- **tabs:** Needed to enumerate every open tab across all windows and read its URL
  and status so restricted pages such as `chrome:`, `chrome-extension:`, and
  `devtools:` are skipped instead of failing.
- **scripting:** Needed to inject the packaged capture function before reload and
  the packaged restoration script afterward, only in tabs the user granted
  access to.
- **storage:** Needed for temporary operation recovery in
  `refreshOperationState`, up to ten counts-only summaries in `refreshHistory`,
  and the local cached-bytes counter in `cacheStats`. The session snapshot holds
  tab objects and per-tab status only while a run is active. Durable history has
  no URLs, titles, or favicons.
- **optional host access (`<all_urls>`):** Requested at runtime from the user's
  first refresh action, and available later from Settings. It is used only to
  capture and restore supported media state and to perform the cache measurement
  introduced in v2.3.0 on accessible sites. If the user refuses, all accessible
  tabs are still refreshed with local-cache bypass; media preservation stops,
  no measurement runs, and the popup says access is unavailable.
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

- **Web history:** Open-tab URLs, titles, and favicon URLs are processed locally
  to identify and refresh tabs, show progress, and recover an active operation.
  The extension does not build or transmit a browsing-history log.
- **Website content:** Supported audio/video element properties, media source
  URLs, and the extension's media-state value in page `sessionStorage` are
  processed locally to preserve playback state across a refresh. The
  `transferSize`, `decodedBodySize`, and `encodedBodySize` fields in Resource
  Timing entries are processed locally to produce one cached-byte count per tab.
  No resource URLs, names, or timing values leave the page.

These are the only two categories because session storage contains the same
temporary tab details, while durable history contains counts only and
`cacheStats` contains only aggregate byte totals.

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
  be entered in the Developer Dashboard before submission: this release does
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
Policies for a sustained period: it is a function of **publisher history**, not
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
review for adherence to Store best practices: technical quality, a genuinely
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

Refresh Em All satisfies the credential-free criterion in code: the popup's refresh action needs
no account, no login, and no payment. Every other item is an account or
dashboard fact that cannot be verified from this repository.

### Nomination step

Featured nomination is manual. After the public v2.4.4 version is live and
stable, submit it through **One Stop Support** in the Developer Dashboard. There
is no API and no automatic nomination.

**Featured evaluation is manual, discretionary, and not guaranteed.** This
release produces a verified candidate. It does not earn, and must not be
described as earning, the badge.

## Visual assets

The listing assets and their reproducible sources live under
`docs/chrome-web-store/assets/`. They are documentation-only Store inputs and
are not included in the extension package.

The icon record below is verified against the v2.4.4 submission package
itself: asset validation reads `icons.128` out of that ZIP and audits the file
it names. The screenshots are current: all ten were recaptured for v2.4.4 from
the artifact recorded below, so their provenance matches the package being
submitted. The submission artifact was rebuilt from this working tree and
recorded as follows:

- **ZIP filename:** `refresh-em-all-v2.4.4.zip`
- **Byte size:** 129691 bytes
- **SHA-256:**
  `641f4afbafd6d2f731d36b5dca35ca2d3e8c64bcf44310d5161bd3893632a5f0`
- All ten 1280×800 screenshots were captured from the v2.4.4 package described
  above, after the capture script verified its hash and reported version.
  - English: `assets/screenshots/*.png` (5 files)
  - Turkish: `assets/screenshots/tr/*.png` (5 files)
- Each capture run also asserts the popup's resolved `@@ui_locale` matches the
  requested locale, so a Turkish set cannot silently be an English one. Asset
  validation additionally rejects duplicate images across locales.
- The screenshots show the ready, in-progress, completed, history, and privacy
  settings states using neutral localhost fixtures and an isolated browser
  profile. Browser chrome, URLs, personal data, local paths, DevTools,
  automation banners, and test identifiers are excluded.
- The capture viewport is 1024×640 CSS px at a 1.25 device scale factor, which
  is exactly the 1280×800 the Store requires. It was widened from 880×550 for
  v2.4.3 because the rethemed popup is 589 CSS px tall and no longer fitted the
  old frame. Both locales fit without clipping or horizontal overflow.
- The capture pins `prefers-color-scheme: light`. The popup gained a dark theme
  in v2.4.2, and on a runner reporting dark it rendered near-white text onto the
  capture's white card, which produced illegible screenshots.
- The required 440×280 promotional PNG is rendered from a self-contained SVG
  source with repository-local tooling and no external fonts or images.
- The packaged 128×128 icon is `assets/icon-refresh-em-colorful-128.png` as of
  v2.4.4, the same artwork the toolbar shows. The audit records a valid 128×128
  PNG with artwork bounds of 95×78 px. Its padding is still opaque, which
  remains documented as a possible future improvement; correcting it would
  require a separately scoped package version rather than replacing a published
  ZIP.

See `docs/chrome-web-store/assets/README.md` for provenance, commands, output
dimensions, and review constraints.

## Submission checklist

Repository-verifiable items are ticked only where this release actually verified
them. Dashboard-only items live in
[`dashboard-checklist.md`](dashboard-checklist.md) and are **not** ticked here.

- [x] Generate five 1280×800 English PNG screenshots from the actual verified
      v2.4.4 package, showing the popup before, during, and after a refresh plus
      local history and privacy settings. Human visual approval is still
      required.
- [x] Generate the matching five Turkish 1280×800 screenshots from the same
      verified v2.4.4 package with a Turkish browser UI locale. Human visual
      approval is still required.
- [x] Generate the required 440×280 PNG promotional image from its repository
      SVG source. Human visual approval is still required.
- [x] Validate the 128×128 icon in the actual v2.4.4 package against current
      Store guidance. Record any retained opaque padding as a known limitation.
      The audit is written to `test-results/chrome-web-store/icon-audit.json`;
      human visual approval is still required.
- [ ] Confirm the actual v2.4.4 package contains both locale catalogs and
      nothing undeclared. The packaging allowlist fails closed on an undeclared
      locale, a stray file inside `_locales/`, or a missing default-locale
      catalog.
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
      skipped, media restoration is best effort, packaged `content-script.js`
      is injected programmatically only after a tab with captured media state
      finishes reloading, the interface is localized with Chrome's built-in
      `chrome.i18n` using packaged static catalogs, and no remote code or
      external reporting endpoint exists.
- [ ] The v2.4.4 package has been built and verified (filename, byte size, and
      SHA-256 recorded above under Visual assets). Before upload, confirm the
      SHA-256 of the exact file being uploaded matches that recorded hash.
- [ ] Work through [`dashboard-checklist.md`](dashboard-checklist.md) in full.
- [ ] Review the current Chrome Web Store dashboard wording immediately before
      submission because policy labels and required fields can change.
- [ ] Do not publish until every listing, privacy, asset, support, distribution,
      and reviewer-note field has been manually reviewed by the publisher.
