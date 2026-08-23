# Contributing Guidelines

This document provides a high-level overview of the project structure and guidelines for contributors.

## Project Structure

```
refresh-em-all/
├── assets/              # Extension icons
├── scripts/             # Deterministic release packaging
├── tests/               # Test files and utilities
│   ├── e2e/             # End-to-end tests
│   ├── stress/          # Stress tests
│   └── *.test.js        # Unit tests
├── background.js        # Extension background script
├── content-script.js    # Just-in-time media state restoration injected after refresh
├── manifest.json        # Extension manifest
├── popup.html           # Extension popup interface
├── popup.js             # Popup functionality
├── TESTING.md           # Test strategy and commands
└── package.json         # NPM configuration
```

## Setup for Contributors

1. Clone the repository
2. Select the repository's Node 24 LTS version: `nvm use` (when using nvm)
3. Install dependencies: `npm ci --legacy-peer-deps`
4. Run tests: `npm test`

The peer-dependency flag is currently required because `jest-chrome@0.8.0`
declares Jest 26/27 support while this repository uses Jest 29. Removing that
compatibility flag requires a reviewed test-mock migration.

## Testing Guidelines

The project includes several testing utilities:

- Unit tests: `npm test`
- Essential E2E and smoke tests: `npm run e2e`
- Packaged-extension smoke test: `npm run e2e:package`
- Medium reliability tests: `npm run e2e:reliability:medium`
- Full reliability tests: `npm run e2e:reliability`
- Stress tests: `npm run stress-test`
- Extension debugging: `npm run debug-extension`

Generated coverage, screenshots, and JSON results are written to ignored output
directories and must not be committed.

## Release Packaging

`npm run package` creates `dist/refresh-em-all-v<version>.zip` from an explicit
runtime-only allowlist and verifies the archive after writing it. The package,
lockfile, manifest, and ZIP filename must use the same version. To inspect an
already-built archive without replacing it, run `npm run package:verify`.

Pushing a `v*` tag triggers the release workflow. Its read-only validation job
runs the unit, essential E2E, packaged-extension smoke, medium, and full
reliability suites and uploads a checksummed ZIP workflow artifact. A separate
write-enabled job publishes only that validated artifact. Existing release assets
are immutable: an identical asset is left in place, while a name collision with
different bytes fails the workflow. Running the workflow manually performs the
same validation and artifact upload but cannot publish a GitHub Release.

## Performance Considerations

When contributing, be mindful of:

- Memory usage when handling multiple tabs
- Batch processing techniques for large operations
- Error handling and recovery mechanisms

## Privacy Guidelines

- Do not add analytics or tracking code
- Avoid including personal identifiers in comments or documentation
- Keep error reporting minimal and focused on technical data

## Pull Request Process

1. Create a branch for your changes
2. Keep changes focused on a single feature or fix
3. Include relevant tests
4. Submit a pull request with a clear description

## Code Style

Follow the existing conventions in the codebase.
