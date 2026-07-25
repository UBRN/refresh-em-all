<p align="center">
  <img src="https://raw.githubusercontent.com/UBRN/refresh-em-all/main/doc/images/overview/hero_image.png" alt="Refresh Em All" width="100%" />
</p>

<h1 align="center">Refresh Em All</h1>

<p align="center">🚀 A lightweight browser extension to refresh all tabs in every window for Chromium-based browsers</p>

## Overview

This extension provides a simple way to refresh multiple tabs at once, with a focus on:

- Performance optimized batch processing
- Memory efficiency
- Error handling and recovery
- Media state preservation

## Features

- One-click refresh for all tabs
- Preserves media playback states
- Handles dormant/discarded tabs
- Error reporting and recovery
- Batch processing to prevent browser overload
- Clear refreshed, failed, and skipped tab counts

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

See the full [Privacy Policy](PRIVACY.md).

## License

[MIT](LICENSE)
