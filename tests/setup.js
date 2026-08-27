const chrome = require('jest-chrome');
const fs = require('fs');
const path = require('path');

// Make chrome global
global.chrome = chrome;

const localeRoot = path.join(__dirname, '..', '_locales');
const catalogCache = new Map();

// Chrome resolves an unsupported UI locale against the default catalog rather than failing,
// so an absent locale directory must behave as an empty catalog, not throw.
function loadCatalog(locale) {
  if (!catalogCache.has(locale)) {
    const catalogPath = path.join(localeRoot, locale, 'messages.json');
    catalogCache.set(
      locale,
      fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : {}
    );
  }
  return catalogCache.get(locale);
}

let currentLocale = 'en';

// Test helper: switch the locale chrome.i18n resolves against.
global.setTestLocale = (locale) => {
  currentLocale = locale;
};

function resolveMessage(key, substitutions) {
  if (key === '@@ui_locale') return currentLocale;
  const entry = loadCatalog(currentLocale)[key] ?? loadCatalog('en')[key];
  if (!entry) return '';

  const values = substitutions === undefined
    ? []
    : (Array.isArray(substitutions) ? substitutions : [substitutions]);
  const placeholders = new Map(
    Object.entries(entry.placeholders || {}).map(([name, value]) => [name.toLowerCase(), value])
  );

  return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
    const placeholder = placeholders.get(name.toLowerCase());
    if (!placeholder) return match;
    return String(placeholder.content).replace(
      /\$(\d)/g,
      (_, index) => values[Number(index) - 1] ?? ''
    );
  });
}

chrome.i18n = {
  ...(chrome.i18n || {}),
  getUILanguage: jest.fn(() => currentLocale),
  getMessage: jest.fn((key, substitutions) => resolveMessage(key, substitutions))
};

const onUpdatedAddListener = jest.fn();
onUpdatedAddListener.callbackQueue = [];
onUpdatedAddListener.mockImplementation(cb => {
  onUpdatedAddListener.callbackQueue.push(cb);
});

const onRemovedAddListener = jest.fn();
onRemovedAddListener.callbackQueue = [];
onRemovedAddListener.mockImplementation(cb => {
  onRemovedAddListener.callbackQueue.push(cb);
});

// Set up Chrome API mock structures with proper Jest mocks
chrome.tabs = {
  ...chrome.tabs,
  query: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  reload: jest.fn(),
  create: jest.fn(),
  remove: jest.fn(),
  onUpdated: {
    addListener: onUpdatedAddListener,
    callbackQueue: [],
    hasListener: jest.fn(),
    removeListener: jest.fn()
  },
  onRemoved: {
    addListener: onRemovedAddListener,
    callbackQueue: [],
    hasListener: jest.fn(),
    removeListener: jest.fn()
  }
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

const defaultMatchMedia = query => ({
  matches: false,
  media: query,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn()
});

window.matchMedia = jest.fn(defaultMatchMedia);

// jest.clearAllMocks() does not restore implementations, so a test that switches locale or
// forces reduced motion has to hand the environment back itself. setupFiles runs before the test
// framework exists, so this cannot be registered as a global beforeEach here, suites that mutate
// the environment call it from their own afterEach instead.
global.resetTestEnvironment = () => {
  currentLocale = 'en';
  window.matchMedia.mockImplementation(defaultMatchMedia);
  chrome.i18n.getUILanguage.mockImplementation(() => currentLocale);
  chrome.i18n.getMessage.mockImplementation((key, substitutions) => resolveMessage(key, substitutions));
};

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
