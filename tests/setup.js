const chrome = require('jest-chrome');

// Make chrome global
global.chrome = chrome;

// Set up Chrome API mock structures with proper Jest mocks
chrome.tabs = {
  ...chrome.tabs,
  query: jest.fn(),
  get: jest.fn(),
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
  session: {
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

window.confirm = jest.fn(() => false);
window.prompt = jest.fn(() => null);

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
