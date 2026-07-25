# Chrome Web Store visual assets

These files are reviewable listing inputs for Refresh Em All v2.0.1. They are
not part of the extension runtime package and must not be added to the package
allowlist in `scripts/package-extension.js`.

## Provenance

The screenshots are captured from the published `refresh-em-all-v2.0.1.zip`
after requiring this SHA-256:

```text
dae27e545bea8b27f842657781ff8fc172c5ccc431e7650357c6098e74f9954d
```

The capture script safely extracts the ZIP into a temporary directory, loads
only that directory in an isolated Chrome for Testing profile, uses neutral
localhost fixtures, and removes the profile and extracted files afterward.
The Store icon inside the package remains unchanged.

## Generate and verify

Use Node.js 24 and the locked dependencies:

```bash
npm ci --legacy-peer-deps
npm run store-assets:capture -- \
  --zip /absolute/path/to/refresh-em-all-v2.0.1.zip \
  --sha256 dae27e545bea8b27f842657781ff8fc172c5ccc431e7650357c6098e74f9954d
npm run store-assets:promo
npm run store-assets:verify -- \
  --zip /absolute/path/to/refresh-em-all-v2.0.1.zip
```

Generated diagnostics and downscaled review copies are written beneath
`test-results/chrome-web-store/`, which is intentionally ignored by Git.

## Outputs

- `screenshots/*.png`: five 1280×800, full-bleed, page-level captures. The
  underlying viewport is 640×400 CSS pixels at a 2× device scale factor.
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
v2.0.1. Any future transparent-padding correction must be a separately scoped
package version and must not replace the published v2.0.1 ZIP.
