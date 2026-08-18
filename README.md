<p align="center">
  <img src="https://raw.githubusercontent.com/UBRN/refresh-em-all/main/doc/images/overview/hero_image.png" alt="Refresh Em All" width="100%" />
</p>

<h1 align="center">Refresh Em All</h1>

<p align="center">🚀 Cache-bypassing reloads for accessible tabs across every browser window</p>

## Overview

Refresh Em All performs a cache-bypassing reload of accessible tabs across
every browser window. Each reload bypasses local cache for that load, making it
similar in purpose to a hard refresh such as Command+Shift+R on macOS.

The extension does not delete cached browsing data or modify cookies, Cache
Storage, service workers, or other site data. It asks Chrome to bypass local
cache only while each tab is reloaded.

The extension focuses on:

- Performance optimized batch processing
- Memory efficiency
- Error handling and recovery
- Media state preservation

## Features

- One-click cache-bypassing reload for accessible tabs in every window
- Hard-refresh-style reloads without deleting site data
- Best-effort preservation of supported media playback state
- Cache-bypassing reloads for dormant/discarded tabs without activating them
- Error reporting and recovery
- Batch processing to prevent browser overload
- Clear refreshed, failed, and skipped tab counts
- English and Turkish interface, following your browser language

## Behavior and limitations

- Browser-internal and extension pages identified as restricted are skipped.
- Tabs that Chrome no longer exposes or refuses to reload are skipped or
  reported as failed.
- Discarded tabs have no live page content, so their media state cannot be
  captured before reload.
- Playback position, play/pause, mute, volume, and playback rate are restored
  only when the page, its media implementation, and Chrome's autoplay rules
  allow it.
- A successful result means Chrome accepted the reload request; it does not
  guarantee that the page later finished loading successfully.

## Installation

### For Users

1. Download the versioned extension ZIP from the matching [GitHub Release](https://github.com/UBRN/refresh-em-all/releases).
2. Extract the ZIP to a permanent local directory.
3. Open `chrome://extensions/` and enable Developer Mode.
4. Select **Load unpacked** and choose the extracted directory.

### For Developers
See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## Packaging

Run `npm run package` to create a verified, installable archive under `dist/`.
The archive contains only extension runtime files. Run `npm run package:verify`
to verify an existing archive without rebuilding it.

## Privacy

This extension:
- Processes tab information and supported media playback state locally
- Keeps transient operation state and up to ten refresh summaries in Chrome storage
- Handles errors locally and sends no browsing data, analytics, telemetry, or error reports
- Bypasses local cache during reload without deleting cached browsing data or site data

See the full [Privacy Policy](PRIVACY.md).

## License

[MIT](LICENSE)
