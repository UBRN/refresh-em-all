// Loads the shipped popup.html into jsdom and runs the instrumented popup.js
// against it, so a renamed id or a missing element fails the popup tests.
const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const repositoryRoot = path.join(__dirname, '..');
const popupPath = path.join(repositoryRoot, 'popup.js');
const popupSource = fs.readFileSync(popupPath, 'utf8');
const popupJs = createInstrumenter().instrumentSync(popupSource, popupPath);
const popupHtml = fs.readFileSync(path.join(repositoryRoot, 'popup.html'), 'utf8');

function renderPopupDom() {
  const parsed = new DOMParser().parseFromString(popupHtml, 'text/html');
  parsed.querySelectorAll('script').forEach(script => script.remove());
  [...document.body.attributes].forEach(attribute => document.body.removeAttribute(attribute.name));
  [...parsed.body.attributes].forEach(attribute => {
    document.body.setAttribute(attribute.name, attribute.value);
  });
  document.body.innerHTML = parsed.body.innerHTML;
}

async function flushPromises() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function executePopupJs({
  operationState = { active: false },
  history = [],
  cacheStats,
  siteAccess = true,
  mediaAccessAsked = true,
  requestAccessResult = false,
  incognito = false,
  activeTab = { id: 7, title: 'Lofi beats - YouTube', url: 'https://www.youtube.com/watch?v=abc' },
  openTabs
} = {}) {
  renderPopupDom();
  const storage = { refreshHistory: history, cacheStats, mediaAccessAsked };
  chrome.runtime.onMessage.callbackQueue = [];
  chrome.runtime.onMessage.addListener.mockImplementation(callback => {
    chrome.runtime.onMessage.callbackQueue.push(callback);
  });
  chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message.action === 'getOperationStatus') callback?.(operationState);
    else if (message.action === 'startRefresh') callback?.({ success: true });
    else if (message.action === 'cancelOperation') callback?.({ success: true });
    return Promise.resolve({});
  });
  chrome.storage.local.get.mockImplementation((keys, callback) => {
    callback(Object.fromEntries(keys.filter(key => storage[key] !== undefined).map(key => [key, storage[key]])));
  });
  chrome.storage.local.set.mockImplementation((values, callback) => {
    Object.assign(storage, values);
    callback?.();
  });
  chrome.storage.local.remove.mockImplementation((keys, callback) => {
    keys.forEach(key => delete storage[key]);
    callback?.();
  });
  chrome.tabs.query.mockImplementation(query => Promise.resolve(
    query.active || !openTabs ? (activeTab ? [activeTab] : []) : openTabs
  ));
  chrome.permissions = {
    contains: jest.fn().mockResolvedValue(siteAccess),
    request: jest.fn().mockResolvedValue(requestAccessResult)
  };
  chrome.windows = {
    getCurrent: jest.fn().mockResolvedValue({ id: 1, incognito })
  };

  new Function('document', 'window', 'chrome', popupJs)(document, window, chrome);
  const onMessage = chrome.runtime.onMessage.callbackQueue[0];
  onMessage.storage = storage;
  return onMessage;
}

module.exports = { executePopupJs, flushPromises, popupHtml, popupSource, renderPopupDom, repositoryRoot };
