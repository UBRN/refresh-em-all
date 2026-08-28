# Chrome Web Store visual assets

These files are reviewable listing inputs for Refresh Em All v2.4.3. They are
not part of the extension runtime package and must not be added to the package
allowlist in `scripts/package-extension.js`.

## Provenance

The screenshots are captured from `refresh-em-all-v2.4.3.zip` (144,398 bytes)
after requiring this SHA-256:

```text
30294f1646c66cd74d29a1382c30a37f81d64cce935d7a07bdc3e8c8ea6db86a
```

Each capture run also asserts that the loaded extension reports version 2.4.3
and that the popup's resolved `@@ui_locale` matches the requested `--locale`,
so a localized set cannot silently be a copy of another language.

The capture script safely extracts the ZIP into a temporary directory, loads
only that directory in an isolated Chrome for Testing profile, uses neutral
localhost fixtures, and removes the profile and extracted files afterward.
The Store icon inside the package remains unchanged.

## Capture viewport

The capture viewport is 1024x640 CSS pixels at a device scale factor of 1.25,
which renders to exactly 1280x800. It has grown twice, each time because the
popup outgrew the frame and the capture failed closed rather than shipping a
clipped card: 640x400 at 2x stopped fitting when the cache-statistics section
landed, and 880x550 stopped fitting for v2.4.3 because the v2.4.2 retheme took
the tallest state to roughly 589 CSS pixels. The viewport is sized for that
worst case and the card is centred, so shorter states show even slack above and
below rather than a card clipped at the top.

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
npm ci --legacy-peer-deps
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.4.3.zip \
  --sha256 30294f1646c66cd74d29a1382c30a37f81d64cce935d7a07bdc3e8c8ea6db86a \
  --expect-version 2.4.3 --locale en
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.4.3.zip \
  --sha256 30294f1646c66cd74d29a1382c30a37f81d64cce935d7a07bdc3e8c8ea6db86a \
  --expect-version 2.4.3 --locale tr
npm run store-assets:promo
npm run store-assets:verify -- \
  --zip /absolute/path/to/refresh-em-all-v2.4.3.zip \
  --sha256 30294f1646c66cd74d29a1382c30a37f81d64cce935d7a07bdc3e8c8ea6db86a \
  --expect-version 2.4.3
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

## Deferred icon improvement

The packaged 128×128 Store icon is a valid PNG with exact dimensions, but its
padding is opaque rather than transparent. It is intentionally unchanged for
v2.1.0. Any future transparent-padding correction must be a separately scoped
package version and must not replace an already published ZIP.
