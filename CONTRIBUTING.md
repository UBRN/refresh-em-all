# Contributing Guidelines

This document provides a high-level overview of the project structure and guidelines for contributors.

## Project Structure

```
refresh-em-all/
├── assets/              # Extension icons
├── tests/               # Test files and utilities
│   ├── e2e/             # End-to-end tests
│   ├── stress/          # Stress tests
│   └── *.test.js        # Unit tests
├── background.js        # Extension background script
├── content-script.js    # Content script for tab state preservation
├── manifest.json        # Extension manifest
├── popup.html           # Extension popup interface
├── popup.js             # Popup functionality
├── IMPROVEMENTS.md      # Documentation of performance improvements
└── package.json         # NPM configuration
```

## Setup for Contributors

1. Clone the repository
2. Install dependencies: `npm install`
3. Run tests: `npm test`

## Testing Guidelines

The project includes several testing utilities:

- Unit tests: `npm test`
- End-to-end tests: `npm run e2e`
- Stress tests: `npm run stress-test`
- Extension debugging: `npm run debug-extension`

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