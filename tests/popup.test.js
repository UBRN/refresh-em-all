// Import functions from popup.js
const path = require('path');
const fs = require('fs');

// We need to load the popup.js file content
const popupJsPath = path.join(__dirname, '..', 'popup.js');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

// Create a function to execute the popup.js code in the context of our test
function executePopupJs() {
  // Setup DOM elements that would be queried in popup.js
  document.getElementById.mockImplementation(id => {
    switch (id) {
      case 'refreshAll':
        return {
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
      case 'loadingContainer':
        return { style: {} };
      case 'progressFill':
        return { style: {} };
      case 'statusText':
        return { 
          textContent: '',
          style: {}
        };
      case 'tabsContainer':
        return {
          innerHTML: '',
          appendChild: jest.fn(),
          style: {}
        };
      case 'errorContainer':
        return { style: {} };
      case 'errorSummary':
        return { textContent: '' };
      case 'errorDetails':
        return { textContent: '' };
      case 'historyContainer':
        return { style: {} };
      case 'historyHeader':
        return { 
          addEventListener: jest.fn(),
          style: {} 
        };
      case 'historyContent':
        return { 
          style: {},
          innerHTML: '' 
        };
      case 'confetti':
        return { 
          style: {},
          innerHTML: '' 
        };
      case 'settingsHeader':
        return { 
          addEventListener: jest.fn(),
          style: {} 
        };
      case 'settingsContent':
        return { style: {} };
      case 'errorReportingToggle':
        return { 
          checked: false,
          addEventListener: jest.fn() 
        };
      case 'pendingErrorsContainer':
        return { style: {} };
      case 'pendingErrorCount':
        return { textContent: '' };
      case 'reportErrorsBtn':
        return { addEventListener: jest.fn() };
      default:
        return null;
    }
  });
  
  // Execute the code
  const scriptFunction = new Function('document', 'window', 'chrome', popupJs);
  scriptFunction(document, window, chrome);
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
    
    // Call the listener
    changeListener();
    
    // Check that storage was updated
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ 
      errorReportingConsent: false 
    }, expect.any(Function));
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
    
    // Check that tabs query was called
    expect(chrome.tabs.query).toHaveBeenCalled();
    
    // Check that UI is updated
    const loadingContainer = document.getElementById('loadingContainer');
    expect(loadingContainer.style.display).toBe('block');
  });
  
  test('should handle stress test mode activation', () => {
    // Mock confirm to return true
    global.confirm = jest.fn().mockReturnValue(true);
    
    executePopupJs();
    
    // Get the settings header element
    const settingsHeader = document.getElementById('settingsHeader');
    
    // Check that an event listener was added
    expect(settingsHeader.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    
    // Get the click listener function
    const clickListener = settingsHeader.addEventListener.mock.calls[0][1];
    
    // Call the listener 5 times
    clickListener();
    clickListener();
    clickListener();
    clickListener();
    clickListener();
    
    // Check that stress test mode was activated (confirm dialog shown)
    expect(global.confirm).toHaveBeenCalled();
    
    // Clean up
    delete global.confirm;
  });
  
  test('should update history display', () => {
    executePopupJs();
    
    // Get updateHistoryDisplay function by creating a proxy that captures it
    let updateHistoryDisplay;
    
    // Override chrome.storage.sync.get
    chrome.storage.sync.get.mockImplementation((keys, callback) => {
      if (keys.includes('refreshHistory') || keys === 'refreshHistory') {
        callback({
          refreshHistory: [
            {
              timestamp: new Date().toISOString(),
              totalTabs: 10,
              successfulTabs: 8,
              failedTabs: [
                { title: 'Failed Tab', error: 'Test error' }
              ]
            }
          ]
        });
        // Attempt to capture updateHistoryDisplay
        const historyContent = document.getElementById('historyContent');
        if (historyContent.innerHTML !== '') {
          updateHistoryDisplay = true;
        }
      } else {
        callback({
          errorReportingConsent: true
        });
      }
    });
    
    // Re-execute to trigger the updated mock
    executePopupJs();
    
    // Check that history display was updated
    expect(updateHistoryDisplay).toBe(true);
  });
}); 