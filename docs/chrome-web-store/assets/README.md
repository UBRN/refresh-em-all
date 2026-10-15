# Chrome Web Store visual assets

These files are reviewable listing inputs for Refresh Em All v2.6.0. They are
not part of the extension runtime package and must not be added to the package
allowlist in `scripts/package-extension.js`.

## Provenance

The screenshots are captured from `refresh-em-all-v2.6.0.zip` (188,142 bytes)
after requiring this SHA-256:

```text
49e1f3b93481a55481b18edcf88517fd92f6938b2bd5cde49fcbdb88b74145f7
```

Each capture run also asserts that the loaded extension reports version 2.6.0
and that the popup's resolved `@@ui_locale` matches the requested `--locale`,
so a localized set cannot silently be a copy of another language.

The capture script safely extracts the ZIP into a temporary directory, loads
only that directory in an isolated Chrome for Testing profile, uses neutral
fixtures served from a local server under the name `example.com` (Chrome maps it
to the loopback address with `--host-resolver-rules`), and removes the profile
and extracted files afterward.
The capture does not touch the Store icon inside the package.

## Capture viewport

The capture viewport is 1024x640 CSS pixels at a device scale factor of 1.25,
which renders to exactly 1280x800. Since v2.6.0 the popup is a fixed 360x480 CSS
pixel frame, so every state fits with the card centred. The ready shot loads the
popup behind an active fixture tab, so "Refresh only this tab" names that
neutral site as it would for a user. The in-progress shot freezes a copy of the
popup when its count matches its chips, and the history and settings shots open
those views inside the popup.

The capture pins `prefers-color-scheme: light`. The popup gained a dark theme in
v2.4.2, and the framing applied at capture time forces a white card, so on a
machine reporting a dark preference the shots came out as near-white text on
white. Pinning the scheme keeps the captures legible and deterministic across
machines.

Before clicking refresh, `scripts/chrome-web-store/capture-screenshots.js` seeds
`mediaAccessAsked` in `chrome.storage.local` because automation cannot dismiss
Chrome's native permission dialog. This suppresses the automatic prompt; it does
not grant the optional host permission, so the captures show the popup as a user
who has not granted page access sees it.

## Generate and verify

Use Node.js 24 and the locked dependencies:

```bash
npm ci
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.6.0.zip \
  --sha256 49e1f3b93481a55481b18edcf88517fd92f6938b2bd5cde49fcbdb88b74145f7 \
  --expect-version 2.6.0 --locale en
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.6.0.zip \
  --sha256 49e1f3b93481a55481b18edcf88517fd92f6938b2bd5cde49fcbdb88b74145f7 \
  --expect-version 2.6.0 --locale tr
npm run store-assets:promo
npm run store-assets:verify -- \
  --zip /absolute/path/to/refresh-em-all-v2.6.0.zip \
  --sha256 49e1f3b93481a55481b18edcf88517fd92f6938b2bd5cde49fcbdb88b74145f7 \
  --expect-version 2.6.0
```

Generated diagnostics and downscaled review copies are written beneath
`test-results/chrome-web-store/`, which is intentionally ignored by Git.

## Outputs

- `screenshots/*.png`: five 1280×800, full-bleed, page-level captures in the
  default locale (English). The underlying viewport is 1024×640 CSS pixels at a
  1.25× device scale factor.
- `screenshots/tr/*.png`: the same five states captured with a Turkish browser
  UI locale. Every additional Store language gets a sibling subdirectory named
  after its locale; `store-assets:verify` requires a complete set for every
  locale shipped in `_locales/` and rejects duplicate images across locales.
  On macOS the capture script overrides the browser UI language through
  `-AppleLanguages`, because Chrome ignores `--lang` there.
- `promo/small-440x280.svg`: self-contained promotional artwork source with no
  text, fonts, scripts, external images, or network references.
- `promo/small-440x280.png`: required 440×280 promotional image rendered from
  the SVG with the locked Sharp dependency.

The screenshots intentionally exclude the toolbar, omnibox, tab strip,
profiles, bookmarks, URLs, external websites, personal information, DevTools,
automation banners, local paths, and test identifiers. Review screenshots at
both 1280×800 and 640×400, and review the promo at both 440×280 and 220×140.

## Icon

The packaged Store icon is `assets/icon-128.png`: the blue tile drawn from
`assets/icon.svg`, with 96x96 px artwork inside a transparent 16 px margin.
`npm run generate-icons` renders every icon size and the favicon from the two
SVG sources, and `store-assets:verify --zip` fails if the packaged icon's
artwork leaves that margin.
