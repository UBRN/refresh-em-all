// Import functions from content-script.js
const path = require('path');
const fs = require('fs');

// We need to load the content-script.js file content
const contentScriptPath = path.join(__dirname, '..', 'content-script.js');
const contentScript = fs.readFileSync(contentScriptPath, 'utf8');

// Create a function to execute the content-script.js code in the context of our test
function executeContentScript() {
  // Mock sessionStorage for the test
  sessionStorage.getItem.mockImplementation(key => {
    if (key === 'refreshEmAllMediaState') {
      return JSON.stringify({
        'video_0': {
          paused: true,
          currentTime: 10,
          src: 'https://example.com/video.mp4'
        },
        'audio_0': {
          paused: false,
          currentTime: 5,
          src: 'https://example.com/audio.mp3'
        }
      });
    }
    return null;
  });
  
  // Mock document.querySelectorAll for videos and audios
  document.querySelectorAll.mockImplementation(selector => {
    if (selector === 'video') {
      return [{
        src: 'https://example.com/video.mp4',
        currentTime: 0,
        paused: false,
        pause: jest.fn()
      }];
    } else if (selector === 'audio') {
      return [{
        src: 'https://example.com/audio.mp3',
        currentTime: 0,
        paused: true,
        pause: jest.fn()
      }];
    }
    return [];
  });
  
  // Create a new MutationObserver mock
  global.MutationObserver = jest.fn().mockImplementation(callback => {
    return {
      observe: jest.fn(),
      disconnect: jest.fn()
    };
  });
  
  // Mock setTimeout
  jest.useFakeTimers();
  
  try {
    // Execute the content script
    const scriptFunction = new Function('document', 'window', 'chrome', 'sessionStorage', 'MutationObserver', contentScript);
    scriptFunction(document, window, chrome, sessionStorage, MutationObserver);
    
    // Run timers
    jest.runAllTimers();
    
    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error
    };
  }
}

describe('Content Script Tests', () => {
  beforeEach(() => {
    // Reset all mock function calls
    jest.clearAllMocks();
    
    // Setup chrome API mocks
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (callback) callback({ success: true });
    });
    
    // Reset timers
    jest.useFakeTimers();
  });
  
  afterEach(() => {
    jest.useRealTimers();
  });
  
  test('should register error event listener', () => {
    executeContentScript();
    
    // Check error handler was set up
    expect(window.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
  });
  
  test('should restore media state from sessionStorage', () => {
    executeContentScript();
    
    // Check that sessionStorage was queried
    expect(sessionStorage.getItem).toHaveBeenCalledWith('refreshEmAllMediaState');
    
    // Check that sessionStorage item was removed
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('refreshEmAllMediaState');
    
    // Check that videos were queried
    expect(document.querySelectorAll).toHaveBeenCalledWith('video');
    
    // Check that audios were queried
    expect(document.querySelectorAll).toHaveBeenCalledWith('audio');
  });
  
  test('should set up MutationObserver for dynamic media elements', () => {
    executeContentScript();
    
    // Check that MutationObserver was created
    expect(MutationObserver).toHaveBeenCalled();
    
    // Get the observer instance
    const observerInstance = MutationObserver.mock.instances[0];
    
    // Check that observe was called
    expect(observerInstance.observe).toHaveBeenCalled();
    
    // Check that disconnect timer was set
    expect(setTimeout).toHaveBeenCalled();
    
    // Fast-forward and trigger all the timers
    jest.runAllTimers();
    
    // Check that the observer was disconnected
    expect(observerInstance.disconnect).toHaveBeenCalled();
  });
  
  test('should show success notification', () => {
    document.createElement.mockImplementation((tag) => {
      const element = {
        style: {},
        appendChild: jest.fn(),
        parentNode: {
          removeChild: jest.fn()
        }
      };
      return element;
    });
    
    executeContentScript();
    
    // Check notification was created
    expect(document.createElement).toHaveBeenCalledWith('div');
    
    // Check notification was added to the body
    expect(document.body.appendChild).toHaveBeenCalled();
    
    // Check that the timeouts were set for animation
    expect(setTimeout).toHaveBeenCalledTimes(3); // mutation observer + 2 for notification
    
    // Fast-forward and trigger all the timers
    jest.runAllTimers();
  });
  
  test('should report successful refresh to background script', () => {
    executeContentScript();
    
    // Check that a message was sent to report success
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'reportError',
      errorType: 'tab_refresh_success',
      errorDetails: expect.objectContaining({
        url: expect.any(String),
        mediaRestored: true
      })
    });
  });
  
  test('should handle errors gracefully', () => {
    // Make sessionStorage.getItem throw an error
    sessionStorage.getItem.mockImplementation(() => {
      throw new Error('Test error');
    });
    
    executeContentScript();
    
    // Check that the error was logged
    expect(console.error).toHaveBeenCalled();
    
    // Check that the error was reported
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'reportError',
      errorType: 'content_script_exception',
      errorDetails: expect.objectContaining({
        message: 'Test error'
      })
    });
  });
}); 