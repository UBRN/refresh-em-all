<p align="center">
  <img src="https://raw.githubusercontent.com/UBRN/refresh-em-all/main/doc/images/overview/hero_image.png" alt="Refresh Em All" width="100%" />
</p>

<h1 align="center">Refresh Em All</h1>

<p align="center">Reload your tabs and fetch fresh files instead of reusing copies Chrome saved earlier</p>

## Overview

Refresh Em All reloads the tabs it can across every browser window. For each
reload, it tells Chrome to fetch fresh files instead of reusing copies Chrome
saved earlier. It does not delete those copies or change cookies, site storage,
service workers, or other site data.

With one click, you can:

- Reload your tabs without opening each one
- Keep videos and audio where you left them, on a best-effort basis
- Reload sleeping tabs without bringing them to the front
- See which reloads Chrome accepted, which failed, and which were skipped
- Cancel while a reload is running

Errors are shown only to you on this device. The extension does not send error
reports anywhere.

## Features

- Reloads the tabs it can in every window, a few tabs at a time
- Fetches fresh files instead of reusing copies Chrome saved earlier
- Keeps playback position, play/pause state, mute, volume, and playback speed
  on a best-effort basis
- Measures at least the size of files that came from copies Chrome saved
  earlier and will now be downloaded again
- Shows figures for the last reload, today, the last 7 days, the last 30 days,
  and all time
- Works without permission to read the pages you refresh; if you say no, no
  new saved-file data is measured and media settings cannot be read or restored
- Shows up to ten recent reload summaries
- Uses English or Turkish, following your browser language

## Behavior and limitations

- Chrome's own pages, which no extension can reload, are skipped.
- Tabs that close or that Chrome refuses to reload are skipped or shown as
  failed.
- Sleeping tabs have no live page content, so their media settings cannot be
  read before reload.
- Keeping videos and audio where you left them is best effort. It depends on
  the page, its player, and Chrome's autoplay rules.
- A successful result means Chrome accepted the reload. It does not mean the
  page finished loading.
- Every saved-file figure says **at least** because the real number is higher. Some
  files do not tell the page their size, and Chrome keeps only a limited number
  of the load records it already has for the page.
- The figures do not show deleted cache, freed disk space, or a measured amount
  saved. They add up files that came from copies Chrome saved earlier and will
  now be downloaded again.

## Optional permission

Refresh Em All asks for permission to read the pages you refresh. It uses this
optional permission only to keep videos and audio where you left them on a
best-effort basis and to measure files served from copies Chrome saved earlier.
Reloading still works if you say no. You can grant the permission later in
**Settings**.

## Installation

### Chrome Web Store

Install [Refresh Em All from the Chrome Web Store](https://chromewebstore.google.com/detail/ehdbiccffaflnaijdplgnmbjadjoenek).

### Developer or pre-release builds

1. Download the versioned extension ZIP from the matching [GitHub Release](https://github.com/UBRN/refresh-em-all/releases).
2. Extract the ZIP to a permanent local directory.
3. Open `chrome://extensions/` and enable Developer Mode.
4. Select **Load unpacked** and choose the extracted directory.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## Packaging

Run `npm run package` to create a verified, installable archive under `dist/`.
The archive contains only extension runtime files. Run `npm run package:verify`
to verify an existing archive without rebuilding it.

## Privacy

This extension keeps the following information on your device:

- Temporary progress for the current reload and up to ten recent summaries
- Saved-file figures for the latest reload, the running total, and up to 31 days
- Whether it already asked for the optional page-reading permission

For best-effort media restoration, the refreshed page's own playback settings
briefly go into temporary storage that clears with the tab. The page can read
that information until it is cleared. This extension sends no browsing data,
saved-file figures, media settings, usage data, or error reports anywhere.

See the full [Privacy Policy](PRIVACY.md).

## License

[MIT](LICENSE)
