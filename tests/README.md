# Testing Refresh-Em-All Extension

This directory contains comprehensive testing tools for the Refresh-Em-All Chrome extension. These tools are designed to ensure the extension's reliability, performance, and resilience against issues like memory leaks, excessive resource usage, and API errors.

## Available Tests

### 1. Unit Tests

Unit tests validate individual functions and components in isolation:

```bash
npm test               # Run all unit tests
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Generate coverage report
npm run test:debug     # Run tests with Node.js debugger attached
```

### 2. End-to-End Tests

E2E tests automate user flows and interactions with the extension in a real browser:

```bash
npm run e2e
```

### 3. Stress Tests

Stress tests push the extension to its limits to identify breaking points and performance issues:

```bash
npm run stress-test       # Run the standard stress test
npm run stress-test:debug # Run with debugger attached
```

The stress test:
- Incrementally increases the number of tabs
- Monitors memory usage
- Records errors and performance metrics
- Continues until a failure occurs or max iterations are reached

Results are saved to `tests/stress/stress-test-results.json`.

### 4. Verification Tests

Verification tests ensure the extension works correctly after code changes:

```bash
npm run verify
```

This runs a basic verification test with 10 tabs to check:
- Extension loads correctly
- Tab refresh operation works
- No errors are encountered
- Performance metrics are within acceptable ranges

Results are saved to `tests/verification-results.json`.

### 5. UUID Analysis Tool

This tool helps identify and diagnose errors by UUID:

```bash
npm run analyze-uuid <uuid>
```

For example:
```bash
npm run analyze-uuid fbf7234f-c82b-4801-9981-5c5695a5633c
```

The analyzer:
- Validates UUID format
- Matches against known error patterns
- Checks stress test results for matches
- Provides possible causes and solutions

## Troubleshooting Common Issues

### Chrome API Errors (fbf7-* pattern)

UUIDs starting with `fbf7` often indicate Chrome internal errors related to extension API usage, typically caused by:

1. **Memory Usage**: Processing too many tabs simultaneously
   - Solution: Process tabs in smaller batches with delays

2. **Background Page Termination**:
   - Solution: Implement error handling and recovery logic

3. **Permission Issues**:
   - Solution: Verify manifest permissions match the APIs being used

### Storage Errors (a5c3-* pattern)

UUIDs starting with `a5c3` indicate storage-related issues:

1. **Storage Quota Exceeded**:
   - Solution: Implement cleanup for older history items

2. **Corrupted Storage Data**:
   - Solution: Add data validation before storing

3. **Concurrent Write Operations**:
   - Solution: Use transactions for critical storage operations

## Tips for Effective Testing

1. Start with unit tests to catch basic issues
2. Run verification tests after any significant code changes
3. Run stress tests periodically during development
4. Use the UUID analyzer when errors occur in production

## Contributing Tests

When adding new tests:
1. Place unit tests in `tests/*.test.js`
2. Add any new test scripts to `package.json`
3. Update this README with documentation for your tests 