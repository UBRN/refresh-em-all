const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const repositoryRoot = path.join(__dirname, '..');
const localeRoot = path.join(repositoryRoot, '_locales');
const popupPath = path.join(repositoryRoot, 'popup.js');
const popupSource = fs.readFileSync(popupPath, 'utf8');
const popupJs = createInstrumenter().instrumentSync(popupSource, popupPath);
const catalogs = Object.fromEntries(['en', 'tr'].map(locale => [
  locale,
  JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'messages.json'), 'utf8'))
]));

function renderPopupDom() {
  document.body.innerHTML = `
    <h2></h2>
    <p class="refresh-explanation"></p>
    <button id="refreshAll">Refresh All Tabs</button>
    <button id="cancelRefresh" style="display:none">Cancel</button>
    <div id="loadingContainer" style="display:none">
      <div id="progressBar" aria-valuenow="0"><div id="progressFill"></div></div>
      <div id="statusText"></div>
      <div id="tabsContainer"></div>
    </div>
    <div id="errorContainer" style="display:none">
      <div id="errorSummary"></div><div id="errorDetails"></div>
    </div>
    <div id="historyContainer" style="display:none">
      <button id="historyHeader" aria-expanded="false"></button>
      <div id="historyContent" style="display:none"></div>
    </div>
    <button id="settingsHeader" aria-expanded="false"></button>
    <div id="settingsContent" style="display:none"><p class="privacy-info"></p></div>
    <div id="confetti" style="display:none"></div>
  `;
}

function executePopupJs({ operationState = { active: false }, history = [] } = {}) {
  renderPopupDom();
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
    callback({ refreshHistory: history });
  });

  new Function('document', 'window', 'chrome', popupJs)(document, window, chrome);
  return chrome.runtime.onMessage.callbackQueue[0];
}

describe('Localization contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetTestEnvironment();
  });

  test('catalogs have matching keys and valid matching placeholders', () => {
    expect(Object.keys(catalogs.tr).sort()).toEqual(Object.keys(catalogs.en).sort());

    for (const key of Object.keys(catalogs.en)) {
      const placeholderNames = {};
      for (const locale of ['en', 'tr']) {
        const entry = catalogs[locale][key];
        placeholderNames[locale] = Object.keys(entry.placeholders || {}).sort();
        const referencedNames = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)]
          .map(match => match[1].toLowerCase())
          .sort();

        expect(referencedNames).toEqual(placeholderNames[locale]);
        for (const placeholder of Object.values(entry.placeholders || {})) {
          expect(placeholder.content).toMatch(/^\$[1-9]$/);
        }
      }
      expect(placeholderNames.tr).toEqual(placeholderNames.en);
    }
  });

  test('catalog messages and descriptions are not empty', () => {
    for (const catalog of Object.values(catalogs)) {
      for (const entry of Object.values(catalog)) {
        expect(typeof entry.message).toBe('string');
        expect(entry.message.trim()).not.toBe('');
        expect(typeof entry.description).toBe('string');
        expect(entry.description.trim()).not.toBe('');
      }
    }
  });

  test('manifest locale references resolve against its default catalog', () => {
    const manifestPath = path.join(repositoryRoot, 'manifest.json');
    const manifestSource = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestSource);
    const referencedKeys = [...manifestSource.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)]
      .map(match => match[1]);

    expect(manifest.default_locale).toBe('en');
    for (const key of referencedKeys) expect(catalogs.en).toHaveProperty(key);
    expect(fs.existsSync(path.join(localeRoot, manifest.default_locale, 'messages.json'))).toBe(true);
  });

  test('packaging includes every locale catalog on disk', () => {
    const { RUNTIME_FILES } = require('../scripts/package-extension');
    const localeFiles = fs.readdirSync(localeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => `_locales/${entry.name}/messages.json`)
      .filter(relativePath => fs.existsSync(path.join(repositoryRoot, relativePath)));

    expect(RUNTIME_FILES).toEqual(expect.arrayContaining([
      '_locales/en/messages.json',
      '_locales/tr/messages.json'
    ]));
    for (const localeFile of localeFiles) expect(RUNTIME_FILES).toContain(localeFile);
  });

  test('chrome.i18n substitutes dynamic placeholders in the catalog order', () => {
    setTestLocale('en');
    expect(chrome.i18n.getMessage('statusProgress', ['4', '8', '3', '0', '1'])).toBe(
      'Processed 4/8 — 3 refreshed, 0 failed, 1 skipped'
    );
    expect(chrome.i18n.getMessage('statusCompleteAll', ['8'])).toBe(
      'All 8 tabs refreshed successfully!'
    );
    expect(chrome.i18n.getMessage('errorTabLine', ['2', 'Example', 'Failed'])).toBe(
      '2. Example: Failed'
    );

    setTestLocale('tr');
    expect(chrome.i18n.getMessage('statusProgress', ['4', '8', '3', '0', '1'])).toBe(
      '4/8 sekme işlendi — 3 yenilendi, 0 başarısız, 1 atlandı'
    );
    expect(chrome.i18n.getMessage('statusCompleteAll', ['8'])).toBe(
      '8 sekmenin tamamı yenilendi!'
    );
    expect(chrome.i18n.getMessage('errorTabLine', ['2', 'Örnek', 'Hata'])).toBe(
      '2. Örnek: Hata'
    );
  });

  test('renders the Turkish popup and history from the catalog', () => {
    setTestLocale('tr');
    const onMessage = executePopupJs({
      history: [{
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTabs: 4,
        successfulTabs: 2,
        failedCount: 1,
        skippedCount: 1,
        cancelled: false
      }]
    });

    expect(document.documentElement.lang).toBe('tr');
    expect(document.getElementById('refreshAll').textContent).toBe('Tüm Sekmeleri Yenile');
    expect(document.getElementById('settingsHeader').textContent).toBe('Ayarlar');

    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 3, processedTabs: 3, successfulTabs: 2, failedCount: 0, skippedCount: 1 }
    });

    expect(document.getElementById('statusText').textContent).toBe(
      '2 sekme yenilendi; 1 kısıtlı sekme atlandı.'
    );
    expect(document.getElementById('historyContent').textContent).toContain(
      '2/4 yenilendi, 1 başarısız, 1 atlandı'
    );
  });

  test.each([
    ['tr', 'Örnek: yenilendi', 'Yenileme ilerlemesi'],
    ['en', 'Example: refreshed', 'Refresh progress']
  ])('renders localized accessibility labels in %s', (locale, tabLabel, progressLabel) => {
    setTestLocale(locale);
    const onMessage = executePopupJs();

    onMessage({ action: 'refreshStarted', tabs: [{ id: 1, title: locale === 'tr' ? 'Örnek' : 'Example' }] });
    onMessage({ action: 'tabSucceeded', tabId: 1 });

    expect(document.getElementById('tab-1').getAttribute('aria-label')).toBe(tabLabel);
    expect(document.getElementById('progressBar').getAttribute('aria-label')).toBe(progressLabel);
  });

  test('falls back to the default catalog for an unsupported UI locale', () => {
    setTestLocale('fr');
    executePopupJs();

    // Chrome renders the default catalog here, so the document language must say English —
    // labelling English text as French would mislead assistive technology.
    expect(document.documentElement.lang).toBe('en');
    expect(document.getElementById('refreshAll').textContent).toBe('Refresh All Tabs');
  });

  test('catalogs stay within the substitution syntax the renderers implement', () => {
    // tests/setup.js and scripts/chrome-web-store/capture-screenshots.js both resolve only
    // named $PLACEHOLDER$ references. Chrome also supports bare $1 and $ escapes; if a catalog
    // ever starts using those, those renderers would silently emit the wrong string.
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, entry] of Object.entries(catalog)) {
        expect(`${locale}.${key}: ${entry.message}`).not.toMatch(/\$\$/);
        expect(`${locale}.${key}: ${entry.message}`).not.toMatch(/\$[1-9]/);
      }
    }
  });

  test('production popup contains no stress mode hooks', () => {
    expect(popupSource).not.toMatch(/stress/i);
    expect(popupSource).not.toMatch(/confirm\s*\(/i);
    expect(popupSource).not.toMatch(/prompt\s*\(/i);
  });
});
