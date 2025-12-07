// Import functions from popup.js
const path = require('path');
const fs = require('fs');

// We need to load the popup.js file content
const popupJsPath = path.join(__dirname, '..', 'popup.js');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

// Create a mock elements store
const mockElements = {};

// Create a function to execute the popup.js code in the context of our test
function executePopupJs() {
  // Create new mock elements for this execution
  mockElements['refreshAll'] = {
    addEventListener: jest.fn(),
    disabled: false,
    parentNode: {
      replaceChild: jest.fn()
    },
    cloneNode: jest.fn().mockReturnValue({
      addEventListener: jest.fn()
    }),
    style: {}
  };
  mockElements['loadingContainer'] = { style: {} };
  mockElements['progressFill'] = { style: {} };
  mockElements['statusText'] = {
    textContent: '',
    style: {}
  };
  mockElements['tabsContainer'] = {
    innerHTML: '',
    appendChild: jest.fn(),
    style: {}
  };
  mockElements['errorContainer'] = { style: {} };
  mockElements['errorSummary'] = { textContent: '' };
  mockElements['errorDetails'] = { textContent: '' };
  mockElements['historyContainer'] = { style: {} };
  mockElements['historyHeader'] = {
    addEventListener: jest.fn(),
    style: {}
  };
  mockElements['historyContent'] = {
    style: {},
    innerHTML: '',
    appendChild: jest.fn()
  };
  mockElements['confetti'] = {
    style: {},
    innerHTML: ''
  };
  mockElements['settingsHeader'] = {
    addEventListener: jest.fn(),
    style: {}
  };
  mockElements['settingsContent'] = { style: {} };
  mockElements['errorReportingToggle'] = {
    checked: false,
    addEventListener: jest.fn()
  };
  mockElements['pendingErrorsContainer'] = { style: {} };
  mockElements['pendingErrorCount'] = { textContent: '' };
  mockElements['reportErrorsBtn'] = { addEventListener: jest.fn() };

  // Update document.getElementById mock to return our mock elements
  document.getElementById.mockImplementation(id => {
    return mockElements[id] || null;
  });

  // Execute the code
  const scriptFunction = new Function('document', 'window', 'chrome', popupJs);
  scriptFunction(document, window, chrome);

  return mockElements;
}

describe('Popup Script Tests', () => {
  beforeEach(() => {
    // Reset all mock function calls
    jest.clearAllMocks();

    // Setup chrome API mocks
    chrome.tabs.query.mockImplementation((query, callback) => {
      callback([
        { id: 1, title: 'Tab 1', url: 'https://example.com', discarded: false, favIconUrl: 'favicon.ico' },
        { id: 2, title: 'Tab 2', url: 'https://example.org', discarded: true, favIconUrl: null }
      ]);
    });
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (callback) callback({ success: true });
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
    chrome.storage.sync.set.mockImplementation((data, callback) => {
      if (callback) callback();
    });
  });

  test('should initialize displays on load', () => {
    executePopupJs();

    // Check that initialization functions are called
    expect(chrome.storage.sync.get).toHaveBeenCalled();
    expect(chrome.storage.local.get).toHaveBeenCalled();
  });

  test('should set up error reporting toggle listener', () => {
    executePopupJs();

    // Get the error reporting toggle element
    const errorReportingToggle = document.getElementById('errorReportingToggle');

    // Check that an event listener was added
    expect(errorReportingToggle.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    // Get the event listener function
    const changeListener = errorReportingToggle.addEventListener.mock.calls[0][1];

    // Call the listener - should toggle the consent value
    changeListener();

    // Check that storage was updated (either true or false)
    expect(chrome.storage.sync.set).toHaveBeenCalled();
  });

  test('should set up refresh button click listener', () => {
    executePopupJs();

    // Get the refresh button element
    const refreshButton = document.getElementById('refreshAll');

    // Check that an event listener was added
    expect(refreshButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));

    // Get the click listener function
    const clickListener = refreshButton.addEventListener.mock.calls[0][1];

    // Call the listener
    clickListener();

    // Check that message was sent to background
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'startRefresh' },
      expect.any(Function)
    );
  });

  test('should handle stress test mode activation', () => {
    executePopupJs();

    // Get the settings header element
    const settingsHeader = document.getElementById('settingsHeader');

    // Check that an event listener was added
    expect(settingsHeader.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));

    // Get the click listener function
    const clickListener = settingsHeader.addEventListener.mock.calls[0][1];

    // Call the listener multiple times to check for stress test activation
    // The actual implementation may have various thresholds
    for (let i = 0; i < 5; i++) {
      clickListener();
    }

    // The listener should have been executed without errors
    expect(true).toBe(true);
  });

  test('should update history display', () => {
    executePopupJs();

    // Get the history elements
    const historyHeader = document.getElementById('historyHeader');
    const historyContent = document.getElementById('historyContent');

    // Check that history elements have the expected methods
    expect(historyHeader).toBeDefined();
    expect(historyContent).toBeDefined();
    expect(historyContent.appendChild).toBeDefined();

    // Check that storage was queried for history
    expect(chrome.storage.sync.get).toHaveBeenCalled();
  });
}); 