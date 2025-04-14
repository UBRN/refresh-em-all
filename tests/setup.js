const chrome = require('jest-chrome');

// Make chrome global
global.chrome = chrome;

// Set up Chrome API mock structures
chrome.tabs = {
  ...chrome.tabs,
  query: jest.fn(),
  update: jest.fn(),
  reload: jest.fn(),
  create: jest.fn(),
  remove: jest.fn()
};

chrome.runtime = {
  ...chrome.runtime,
  sendMessage: jest.fn(),
  onMessage: {
    addListener: jest.fn(),
    callbackQueue: [],
    hasListener: jest.fn(),
    removeListener: jest.fn()
  }
};

chrome.action = {
  ...chrome.action,
  setIcon: jest.fn(),
  setBadgeText: jest.fn(),
  setBadgeBackgroundColor: jest.fn(),
  onClicked: {
    addListener: jest.fn(),
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

// Mock sessionStorage
global.sessionStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn()
};

// Mock document
global.document = {
  ...document,
  title: 'Test Page',
  querySelector: jest.fn(),
  querySelectorAll: jest.fn().mockReturnValue([]),
  getElementById: jest.fn(),
  createElement: jest.fn().mockImplementation((tag) => {
    return {
      style: {},
      appendChild: jest.fn(),
      addEventListener: jest.fn(),
      setAttribute: jest.fn(),
      removeChild: jest.fn(),
      innerHTML: '',
      cloneNode: jest.fn().mockReturnValue({
        addEventListener: jest.fn()
      }),
      parentNode: {
        replaceChild: jest.fn()
      }
    };
  }),
  body: {
    appendChild: jest.fn(),
  },
  documentElement: {
    appendChild: jest.fn(),
  },
  head: {
    appendChild: jest.fn(),
  },
};

// Mock window
global.window = {
  ...window,
  addEventListener: jest.fn(),
  location: {
    href: 'https://example.com',
    search: ''
  }
};

// Mock console error to track errors during tests
global.console.error = jest.fn();
global.console.log = jest.fn();

// Mock MutationObserver
global.MutationObserver = jest.fn().mockImplementation(() => {
  return {
    observe: jest.fn(),
    disconnect: jest.fn()
  };
}); 