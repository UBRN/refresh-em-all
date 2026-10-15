const fs = require('fs');
const path = require('path');
const { executePopupJs, popupSource, repositoryRoot } = require('./popup-harness');

const localeRoot = path.join(repositoryRoot, '_locales');
const catalogs = Object.fromEntries(['en', 'tr'].map(locale => [
  locale,
  JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'messages.json'), 'utf8'))
]));

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
        const referencedSpelling = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)]
          .map(match => match[1]);

        expect(referencedNames).toEqual(placeholderNames[locale]);
        for (const name of referencedSpelling) expect(name).toBe(name.toUpperCase());
        for (const placeholder of Object.values(entry.placeholders || {})) {
          expect(placeholder.content).toMatch(/^\$[1-9]$/);
        }
      }
      expect(placeholderNames.tr).toEqual(placeholderNames.en);
    }
  });

  // One word for each thing: buttons say Refresh, everything else says reload, and
  // neither language names the cache or the popup.
  test('catalog messages keep to the product vocabulary', () => {
    const buttons = ['actionRefreshAll', 'refreshThisTab', 'askAllow', 'askSkip'];
    for (const [key, { message }] of Object.entries(catalogs.en)) {
      const text = message.replace(/Refresh Em All/g, '').replace(/\$[A-Z0-9_]+\$/g, '');
      if (!buttons.includes(key)) expect([key, text]).not.toEqual([key, expect.stringMatching(/refresh/i)]);
      expect([key, text]).not.toEqual([key, expect.stringMatching(/\bcache|\bpopup/i)]);
    }
    for (const [key, { message }] of Object.entries(catalogs.tr)) {
      expect([key, message]).not.toEqual([key, expect.stringMatching(/yeniden yükle|önbellek|açılır pencere|Yalnızca/i)]);
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
    expect(chrome.i18n.getMessage('statusCompleteMixed', ['4', '8', '3', '0', '1'])).toBe(
      '4 of 8 done: 3 reloaded, 0 failed, 1 skipped.'
    );
    expect(chrome.i18n.getMessage('statusCompleteAll', ['8'])).toBe(
      'All 8 tabs reloaded.'
    );
    expect(chrome.i18n.getMessage('heroLastRun', ['2 hours ago', '6', '8'])).toBe(
      'Last reload 2 hours ago: 6 of 8 reloaded'
    );

    setTestLocale('tr');
    expect(chrome.i18n.getMessage('statusCompleteMixed', ['4', '8', '3', '0', '1'])).toBe(
      '8 sekmeden 4 tanesi bitti: 3 yenilendi, 0 başarısız, 1 atlandı.'
    );
    expect(chrome.i18n.getMessage('statusCompleteAll', ['8'])).toBe(
      '8 sekmenin tümü yenilendi.'
    );
    expect(chrome.i18n.getMessage('heroLastRun', ['2 saat önce', '6', '8'])).toBe(
      'Son yenileme 2 saat önce: 8 sekmeden 6 tanesi yenilendi'
    );
  });

  test('renders the Turkish popup and history from the catalog', async () => {
    jest.useFakeTimers();
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
    await jest.advanceTimersByTimeAsync(0);

    expect(document.documentElement.lang).toBe('tr');
    expect(document.getElementById('refreshAll').textContent.trim()).toBe('Tüm Sekmeleri Yenile');
    expect(document.getElementById('openSettings').textContent.trim()).toBe('AyarlarSayfa okuma açık');
    expect(document.getElementById('openFiles').textContent.trim()).toBe('Yeniden İndirilen Dosyalar');
    expect(document.getElementById('resetStats').textContent).toBe('İstatistikleri sıfırla');
    expect(document.getElementById('refreshThisTab').textContent.trim()).toBe('Yalnız bu sekmeyi yenileyoutube.com');
    expect(document.getElementById('thisTabNote').textContent).toBe('Dosyaları yeniden indirir, videolar kaldığı yerden sürer.');
    expect(document.querySelector('[data-i18n="statsNote"]').textContent).toBe(catalogs.tr.statsNote.message);

    onMessage({ action: 'refreshStarted', tabs: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    onMessage({
      action: 'refreshComplete', success: true,
      details: { totalTabs: 3, processedTabs: 3, successfulTabs: 2, failedCount: 0, skippedCount: 1 }
    });
    await jest.advanceTimersByTimeAsync(1500);

    expect(document.getElementById('doneTitle').textContent).toBe('2 sekme yenilendi, 1 sekme atlandı.');
    document.getElementById('openHistory').click();
    expect(document.getElementById('historyList').textContent).toContain('4 sekmeden 2 tanesi yenilendi');
    expect(document.getElementById('historyList').textContent).toContain('1 başarısız, 1 atlandı');
    jest.useRealTimers();
  });

  test.each([
    ['tr', 'Sekme yenileme ilerlemesi', 'Geri'],
    ['en', 'Tab reload progress', 'Back']
  ])('renders localized accessibility labels in %s', (locale, progressLabel, backLabel) => {
    setTestLocale(locale);
    executePopupJs();

    expect(document.getElementById('progressBar').getAttribute('aria-label')).toBe(progressLabel);
    expect(document.getElementById('back').getAttribute('aria-label')).toBe(backLabel);
  });

  test('falls back to the default catalog for an unsupported UI locale', () => {
    setTestLocale('fr');
    executePopupJs();

    // Chrome renders the default catalog here, so the document language must say English:
    // labelling English text as French would mislead assistive technology.
    expect(document.documentElement.lang).toBe('en');
    expect(document.getElementById('refreshAll').textContent.trim()).toBe('Refresh All Tabs');
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
