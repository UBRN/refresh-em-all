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
  
  // Execute the code
  const scriptFunction = new Function('self', 'chrome', backgroundJs);
  scriptFunction(self, chrome);
  
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
    
    // Verify that tabs.reload is called for tab 2 (the discarded tab)
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true }, expect.any(Function));
    
    // Mock the callback for update
    const updateCallback = chrome.tabs.update.mock.calls[0][2];
    updateCallback();
    
    // Check that reload is called
    expect(chrome.tabs.reload).toHaveBeenCalled();
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
  
  test('should handle sendPendingErrorReports message', async () => {
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
      action: 'sendPendingErrorReports'
    };
    const sender = {};
    const sendResponse = jest.fn();
    
    // Call listener
    messageListener(message, sender, sendResponse);
    
    // Wait for the promise to resolve
    await new Promise(resolve => setTimeout(resolve, 0));
    
    // Check that sendResponse was called
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    
    // Clean up
    delete global.fetch;
  });
}); 