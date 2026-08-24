# Chrome Web Store visual assets

These files are reviewable listing inputs for Refresh Em All v2.1.0. They are
not part of the extension runtime package and must not be added to the package
allowlist in `scripts/package-extension.js`.

## Provenance

The screenshots are captured from `refresh-em-all-v2.1.0.zip` (111,659 bytes)
after requiring this SHA-256:

```text
b7c1459f5263afca94e54add6458f5e15531f239e31b09e76b7c8805d46b56d5
```

Each capture run also asserts that the loaded extension reports version 2.1.0
and that the popup's resolved `@@ui_locale` matches the requested `--locale`,
so a localized set cannot silently be a copy of another language.

The capture script safely extracts the ZIP into a temporary directory, loads
only that directory in an isolated Chrome for Testing profile, uses neutral
localhost fixtures, and removes the profile and extracted files afterward.
The Store icon inside the package remains unchanged.

## Current v2.4.0 capture note

This document remains the provenance record for the published v2.1.0 assets. For a v2.4.0
capture, pin the new ZIP and SHA-256 and pass `--expect-version 2.4.0`. Review the popup's
new optional-access and cache-statistics UI in addition to the existing states.

Before clicking refresh, `scripts/chrome-web-store/capture-screenshots.js` now seeds
`mediaAccessAsked` in `chrome.storage.local` because automation cannot dismiss Chrome's
native permission dialog. This suppresses the automatic prompt; it does not grant the
optional host permission.

## Generate and verify

Use Node.js 24 and the locked dependencies:

```bash
npm ci --legacy-peer-deps
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.1.0.zip \
  --sha256 b7c1459f5263afca94e54add6458f5e15531f239e31b09e76b7c8805d46b56d5 \
  --expect-version 2.1.0 --locale en
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.1.0.zip \
  --sha256 b7c1459f5263afca94e54add6458f5e15531f239e31b09e76b7c8805d46b56d5 \
  --expect-version 2.1.0 --locale tr
npm run store-assets:promo
npm run store-assets:verify -- \
  --zip /absolute/path/to/refresh-em-all-v2.1.0.zip \
  --sha256 b7c1459f5263afca94e54add6458f5e15531f239e31b09e76b7c8805d46b56d5 \
  --expect-version 2.1.0
```

Generated diagnostics and downscaled review copies are written beneath
`test-results/chrome-web-store/`, which is intentionally ignored by Git.

## Outputs

- `screenshots/*.png`: five 1280×800, full-bleed, page-level captures in the
  default locale (English). The underlying viewport is 640×400 CSS pixels at a
  2× device scale factor.
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
