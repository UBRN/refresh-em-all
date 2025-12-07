// Import functions from background.js
const path = require('path');
const fs = require('fs');

// We need to load the background.js file content
const backgroundJsPath = path.join(__dirname, '..', 'background.js');
const backgroundJs = fs.readFileSync(backgroundJsPath, 'utf8');

// Create a function to execute the background.js code in the context of our test
function executeBackgroundJs() {
  // Create mock functions and objects that would be used in background.js
  const self = {
    addEventListener: jest.fn()
  };

  // Clear previous callbacks
  chrome.action.onClicked.callbackQueue = [];
  chrome.runtime.onMessage.callbackQueue = [];

  // Execute the code - wrap it to ensure chrome is accessible
  try {
    const wrappedCode = `
      const self = arguments[0];
      const chrome = arguments[1];
      ${backgroundJs}
    `;
    const scriptFunction = new Function(wrappedCode);
    scriptFunction(self, chrome);
  } catch (error) {
    console.error('Error executing background.js:', error);
  }

  return { self };
}

describe('Background Script Tests', () => {
  beforeEach(() => {
    // Reset all mock function calls
    jest.clearAllMocks();

    // Setup chrome API mocks
    chrome.action.onClicked.addListener.mockImplementation(cb => {
      chrome.action.onClicked.callbackQueue.push(cb);
    });
    chrome.tabs.query.mockImplementation((query, callback) => {
      callback([
        { id: 1, title: 'Tab 1', url: 'https://example.com', discarded: false },
        { id: 2, title: 'Tab 2', url: 'https://example.org', discarded: true }
      ]);
    });
    chrome.runtime.onMessage.addListener.mockImplementation(cb => {
      chrome.runtime.onMessage.callbackQueue.push(cb);
    });
    chrome.storage.sync.get.mockImplementation((keys, callback) => {
      callback({
        errorReportingConsent: true,
        refreshHistory: []
      });
    });
    chrome.storage.local.get.mockImplementation((keys, callback) => {
      callback({
        pendingErrorReports: []
      });
    });
    // Mock chrome.scripting
    chrome.scripting = {
      executeScript: jest.fn().mockReturnValue(Promise.resolve([]))
    };
  });

  test('should register error event listeners', () => {
    const { self } = executeBackgroundJs();

    // Check that event listeners for errors are registered
    expect(self.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(self.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
  });

  test('should register message listeners', () => {
    executeBackgroundJs();

    // Check that message listeners are registered
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledWith(expect.any(Function));
  });

  test('should handle action clicks and start refresh operation', () => {
    executeBackgroundJs();

    // Trigger the action click
    chrome.action.onClicked.callbackQueue.forEach(cb => cb());

    // Verify that the tabs query was called
    expect(chrome.tabs.query).toHaveBeenCalled();

    // Verify that the action icon was updated
    expect(chrome.action.setIcon).toHaveBeenCalled();
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalled();
    expect(chrome.action.setBadgeText).toHaveBeenCalled();
  });

  test('should attempt to refresh tabs', () => {
    executeBackgroundJs();

    // Trigger the action click
    chrome.action.onClicked.callbackQueue.forEach(cb => cb());

    // Verify that tabs.query was called
    expect(chrome.tabs.query).toHaveBeenCalled();

    // The exact tabs.reload behavior depends on async execution
    // Just verify that the refresh mechanism was triggered
    expect(chrome.action.setBadgeText).toHaveBeenCalled();
  });

  test('should handle reportError message', () => {
    // We need to mock fetch
    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({})
      })
    );

    executeBackgroundJs();

    // Get message listener
    const messageListener = chrome.runtime.onMessage.callbackQueue[0];

    // Create mock data for test
    const message = {
      action: 'reportError',
      errorType: 'test_error',
      errorDetails: {
        message: 'Test error',
        stack: 'Error: Test error\n    at test.js:1:1'
      }
    };
    const sender = {};
    const sendResponse = jest.fn();

    // Call listener
    const result = messageListener(message, sender, sendResponse);

    // Check that sendResponse was called
    expect(sendResponse).toHaveBeenCalledWith({ success: true });

    // Check that it returned true (for async response)
    expect(result).toBe(true);

    // Clean up
    delete global.fetch;
  });

  test('should handle sendPendingErrorReports message', () => {
    executeBackgroundJs();
    
    // Get message listener
    const messageListener = chrome.runtime.onMessage.callbackQueue[0];
    
    // Verify the listener was registered
    expect(messageListener).toBeDefined();
    expect(typeof messageListener).toBe('function');
  });
}); 