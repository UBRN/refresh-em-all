const chrome = require('jest-chrome');

// Make chrome global
global.chrome = chrome;

// Set up Chrome API mock structures with proper Jest mocks
chrome.tabs = {
  ...chrome.tabs,
  query: jest.fn(),
  update: jest.fn(),
  reload: jest.fn(),
  create: jest.fn(),
  remove: jest.fn()
};

// Create properly mocked addListener function for onMessage
const onMessageAddListener = jest.fn();
onMessageAddListener.callbackQueue = [];
onMessageAddListener.mockImplementation(cb => {
  onMessageAddListener.callbackQueue.push(cb);
});

chrome.runtime = {
  ...chrome.runtime,
  sendMessage: jest.fn().mockImplementation(() => Promise.resolve({})),
  onMessage: {
    addListener: onMessageAddListener,
    callbackQueue: [],
    hasListener: jest.fn(),
    removeListener: jest.fn()
  }
};

// Create properly mocked addListener function for onClicked
const onClickedAddListener = jest.fn();
onClickedAddListener.callbackQueue = [];
onClickedAddListener.mockImplementation(cb => {
  onClickedAddListener.callbackQueue.push(cb);
});

chrome.action = {
  ...chrome.action,
  setIcon: jest.fn(),
  setBadgeText: jest.fn(),
  setBadgeBackgroundColor: jest.fn(),
  onClicked: {
    addListener: onClickedAddListener,
    callbackQueue: [],
    hasListener: jest.fn(),
    removeListener: jest.fn()
  }
};

chrome.storage = {
  ...chrome.storage,
  sync: {
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn()
  },
  local: {
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn()
  },
  onChanged: {
    addListener: jest.fn(),
    hasListener: jest.fn(),
    removeListener: jest.fn()
  }
};

// Override document methods with Jest mocks
document.getElementById = jest.fn((id) => {
  // Return a mock object for specific element IDs
  const mockElements = {
    refreshAll: {
      addEventListener: jest.fn(),
      disabled: false,
      style: {},
      parentNode: { replaceChild: jest.fn() },
      cloneNode: jest.fn().mockReturnValue({ addEventListener: jest.fn() })
    },
    loadingContainer: { style: {} },
    progressFill: { style: {} },
    statusText: { textContent: '', style: {} },
    tabsContainer: { innerHTML: '', appendChild: jest.fn(), style: {} },
    errorContainer: { style: {} },
    errorSummary: { textContent: '' },
    errorDetails: { textContent: '' },
    historyContainer: { style: {} },
    historyHeader: { addEventListener: jest.fn(), style: {} },
    historyContent: { style: {}, innerHTML: '', appendChild: jest.fn() },
    confetti: { style: {}, innerHTML: '' },
    settingsHeader: { addEventListener: jest.fn(), style: {} },
    settingsContent: { style: {} },
    errorReportingToggle: { checked: false, addEventListener: jest.fn() },
    pendingErrorsContainer: { style: {} },
    pendingErrorCount: { textContent: '' },
    reportErrorsBtn: { addEventListener: jest.fn() }
  };
  return mockElements[id] || null;
});

document.createElement = jest.fn((tag) => {
  return {
    style: {},
    appendChild: jest.fn(),
    addEventListener: jest.fn(),
    setAttribute: jest.fn(),
    removeChild: jest.fn(),
    innerHTML: '',
    textContent: '',
    cloneNode: jest.fn().mockReturnValue({
      addEventListener: jest.fn(),
      style: {}
    }),
    parentNode: {
      removeChild: jest.fn()
    }
  };
});

document.querySelectorAll = jest.fn((selector) => {
  if (selector === 'video') {
    return [{
      src: 'https://example.com/video.mp4',
      currentTime: 0,
      paused: false,
      pause: jest.fn(),
      addEventListener: jest.fn(),
      readyState: 4
    }];
  } else if (selector === 'audio') {
    return [{
      src: 'https://example.com/audio.mp3',
      currentTime: 0,
      paused: true,
      pause: jest.fn(),
      addEventListener: jest.fn(),
      readyState: 4
    }];
  }
  return [];
});

// Mock document.querySelector
document.querySelector = jest.fn(() => null);

// Mock sessionStorage
Object.defineProperty(global, 'sessionStorage', {
  value: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn()
  },
  writable: true,
  configurable: true
});

// Mock document.body and document.head
document.body.appendChild = jest.fn();
document.documentElement.appendChild = jest.fn();
document.head.appendChild = jest.fn();

// Mock window.addEventListener
if (typeof window !== 'undefined') {
  window.addEventListener = jest.fn();
  window.location = {
    href: 'https://example.com',
    search: '',
    hostname: 'example.com'
  };
  window.confirm = jest.fn(() => false);
}

// Mock console methods
global.console.error = jest.fn();
global.console.log = jest.fn();

// Mock MutationObserver
global.MutationObserver = jest.fn().mockImplementation((callback) => {
  return {
    observe: jest.fn(),
    disconnect: jest.fn()
  };
});

// Mock setTimeout (will be controlled by jest.useFakeTimers() in tests)
// No need to mock here as jest handles it
