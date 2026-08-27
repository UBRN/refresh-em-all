const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

const contentScriptPath = path.join(__dirname, '..', 'content-script.js');
const contentScript = createInstrumenter().instrumentSync(
  fs.readFileSync(contentScriptPath, 'utf8'),
  contentScriptPath
);

function executeContentScript(savedState) {
  sessionStorage.getItem.mockReturnValue(savedState);
  new Function(
    'document', 'window', 'chrome', 'sessionStorage', 'MutationObserver',
    contentScript
  )(document, window, chrome, sessionStorage, global.MutationObserver);
}

function prepareMedia() {
  document.body.innerHTML = '<video src="https://example.com/video.mp4"></video><audio></audio>';
  const video = document.querySelector('video');
  const audio = document.querySelector('audio');

  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(audio, 'readyState', { value: 4, configurable: true });
  video.pause = jest.fn();
  video.play = jest.fn(() => Promise.resolve());
  audio.pause = jest.fn();
  audio.play = jest.fn(() => Promise.resolve());

  return { video, audio };
}

describe('Content-script media restoration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.removeItem.mockImplementation(() => {});
    global.MutationObserver.mockImplementation(() => ({
      observe: jest.fn(),
      disconnect: jest.fn()
    }));
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('restores paused video state and playing audio state', () => {
    const { video, audio } = prepareMedia();
    const savedState = JSON.stringify({
      video_0: {
        paused: true,
        currentTime: 12,
        src: 'https://example.com/video.mp4',
        volume: 0.4,
        muted: true,
        playbackRate: 1.25
      },
      audio_0: {
        paused: false,
        currentTime: 7,
        volume: 0.6,
        muted: false,
        playbackRate: 1
      }
    });

    executeContentScript(savedState);

    expect(video.currentTime).toBe(12);
    expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(true);
    expect(video.pause).toHaveBeenCalled();
    expect(audio.currentTime).toBe(7);
    expect(audio.play).toHaveBeenCalled();
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('refreshEmAllMediaState');
  });

  test('waits for metadata before restoring current time', () => {
    document.body.innerHTML = '<audio></audio>';
    const audio = document.querySelector('audio');
    Object.defineProperty(audio, 'readyState', { value: 0, configurable: true });
    audio.pause = jest.fn();
    audio.play = jest.fn(() => Promise.resolve());

    executeContentScript(JSON.stringify({ audio_0: { paused: true, currentTime: 9 } }));
    expect(audio.currentTime).toBe(0);

    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(9);
    expect(audio.pause).toHaveBeenCalled();
  });

  test('does not restore audio state when reordered sources no longer match', () => {
    document.body.innerHTML = [
      '<audio src="https://example.com/two.mp3"></audio>',
      '<audio src="https://example.com/one.mp3"></audio>'
    ].join('');
    const [firstAudio, secondAudio] = document.querySelectorAll('audio');
    [firstAudio, secondAudio].forEach(audio => {
      Object.defineProperty(audio, 'readyState', { value: 4, configurable: true });
      audio.pause = jest.fn();
      audio.play = jest.fn(() => Promise.resolve());
    });

    executeContentScript(JSON.stringify({
      audio_0: { paused: true, currentTime: 11, src: 'https://example.com/one.mp3' },
      audio_1: { paused: false, currentTime: 22, src: 'https://example.com/two.mp3' }
    }));

    expect(firstAudio.currentTime).toBe(0);
    expect(secondAudio.currentTime).toBe(0);
  });

  test('restores audio without a current source', () => {
    document.body.innerHTML = '<audio></audio>';
    const audio = document.querySelector('audio');
    Object.defineProperty(audio, 'readyState', { value: 4, configurable: true });
    audio.pause = jest.fn();
    audio.play = jest.fn(() => Promise.resolve());

    executeContentScript(JSON.stringify({
      audio_0: {
        paused: true,
        currentTime: 13,
        src: 'https://example.com/previous.mp3'
      }
    }));

    expect(audio.currentTime).toBe(13);
    expect(audio.pause).toHaveBeenCalled();
  });

  test('observes dynamically inserted media for a bounded period', () => {
    prepareMedia();
    const observer = { observe: jest.fn(), disconnect: jest.fn() };
    global.MutationObserver.mockImplementation(() => observer);

    executeContentScript(JSON.stringify({ video_0: { paused: true, currentTime: 1, src: 'https://example.com/video.mp4' } }));

    expect(observer.observe).toHaveBeenCalledWith(document.documentElement, {
      childList: true,
      subtree: true
    });
    jest.advanceTimersByTime(10000);
    expect(observer.disconnect).toHaveBeenCalled();
  });

  test('does not send browsing data or telemetry messages', () => {
    prepareMedia();
    executeContentScript(JSON.stringify({ video_0: { paused: true, currentTime: 1, src: 'https://example.com/video.mp4' } }));

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('handles corrupted session state without throwing', () => {
    expect(() => executeContentScript('{not-json')).not.toThrow();
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('refreshEmAllMediaState');
  });
});
