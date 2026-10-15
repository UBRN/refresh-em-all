const instrumentedSource = require('./instrumented-source');

const contentScript = instrumentedSource('content-script.js');

function executeContentScript(savedState, pageWindow = window) {
  sessionStorage.getItem.mockReturnValue(savedState);
  new Function(
    'document', 'window', 'chrome', 'sessionStorage', 'MutationObserver',
    contentScript
  )(document, pageWindow, chrome, sessionStorage, global.MutationObserver);
}

// A YouTube watch page: the player wraps a video that is already playing.
function youTubePage(videoId) {
  document.body.innerHTML = '<div class="html5-video-player"><video src="blob:https://www.youtube.com/new"></video></div>';
  const video = stubMedia(document.querySelector('video'));
  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  const pageWindow = { location: new URL(`https://www.youtube.com/watch?v=${videoId}`), addEventListener: jest.fn() };
  return { video, pageWindow };
}

function stubMedia(element, readyState = 4) {
  Object.defineProperty(element, 'readyState', { value: readyState, configurable: true });
  element.pause = jest.fn();
  element.play = jest.fn(() => Promise.resolve());
  return element;
}

function prepareMedia() {
  document.body.innerHTML = '<video src="https://example.com/video.mp4"></video><audio></audio>';
  return { video: stubMedia(document.querySelector('video')), audio: stubMedia(document.querySelector('audio')) };
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

  test('leaves autoplay alone for media that was paused before it ever started', () => {
    const { video } = prepareMedia();
    executeContentScript(JSON.stringify({
      video_0: { paused: true, currentTime: 0, src: 'https://example.com/video.mp4', volume: 0.5 }
    }));

    expect(video.volume).toBe(0.5);
    expect(video.pause).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('play'));
    expect(video.pause).not.toHaveBeenCalled();
  });

  test('waits for metadata before restoring current time', () => {
    document.body.innerHTML = '<audio></audio>';
    const audio = stubMedia(document.querySelector('audio'), 0);

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
    const [firstAudio, secondAudio] = [...document.querySelectorAll('audio')].map(audio => stubMedia(audio));

    executeContentScript(JSON.stringify({
      audio_0: { paused: true, currentTime: 11, src: 'https://example.com/one.mp3' },
      audio_1: { paused: false, currentTime: 22, src: 'https://example.com/two.mp3' }
    }));

    expect(firstAudio.currentTime).toBe(0);
    expect(secondAudio.currentTime).toBe(0);
  });

  test('does not restore audio state when reordered <source> children no longer match', () => {
    // Elements that select their resource through a <source> child report an
    // empty .src, so matching on .src alone made every such element look
    // sourceless and skipped the mismatch guard entirely. Identity has to come
    // from the resolved .currentSrc for these.
    document.body.innerHTML = [
      '<audio><source src="https://example.com/two.mp3"></audio>',
      '<audio><source src="https://example.com/one.mp3"></audio>'
    ].join('');
    const [firstAudio, secondAudio] = document.querySelectorAll('audio');
    const resolved = ['https://example.com/two.mp3', 'https://example.com/one.mp3'];
    [firstAudio, secondAudio].forEach((audio, index) => {
      stubMedia(audio);
      // jsdom never runs resource selection, so currentSrc is stubbed the way a
      // real browser would report it once the <source> child is chosen.
      Object.defineProperty(audio, 'currentSrc', { value: resolved[index], configurable: true });
    });

    executeContentScript(JSON.stringify({
      audio_0: { paused: true, currentTime: 11, src: 'https://example.com/one.mp3' },
      audio_1: { paused: false, currentTime: 22, src: 'https://example.com/two.mp3' }
    }));

    expect(firstAudio.currentTime).toBe(0);
    expect(secondAudio.currentTime).toBe(0);
    expect(firstAudio.play).not.toHaveBeenCalled();
    expect(secondAudio.play).not.toHaveBeenCalled();
  });

  test('restores audio that still plays the same <source> child', () => {
    document.body.innerHTML = '<audio><source src="https://example.com/one.mp3"></audio>';
    const audio = stubMedia(document.querySelector('audio'));
    Object.defineProperty(audio, 'currentSrc', {
      value: 'https://example.com/one.mp3',
      configurable: true
    });

    executeContentScript(JSON.stringify({
      audio_0: { paused: true, currentTime: 17, src: 'https://example.com/one.mp3' }
    }));

    expect(audio.currentTime).toBe(17);
    expect(audio.pause).toHaveBeenCalled();
  });

  test('restores audio without a current source', () => {
    document.body.innerHTML = '<audio></audio>';
    const audio = stubMedia(document.querySelector('audio'));

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

  test.each([
    ['the same video', 'AAA', 1200, true],
    ['another video', 'BBB', 0, false]
  ])('YouTube state saved on one video restores on %s only', (_case, videoId, currentTime, paused) => {
    const { video, pageWindow } = youTubePage(videoId);
    executeContentScript(JSON.stringify({
      video_0: { paused: true, currentTime: 1200, src: 'blob:https://www.youtube.com/old', isYouTube: true },
      youtube_player_state: { paused: true, videoId: 'AAA' }
    }), pageWindow);

    expect(video.currentTime).toBe(currentTime);
    expect(video.pause.mock.calls.length > 0).toBe(paused);
  });

  test('YouTube player state leaves an unstarted video to its autoplay', () => {
    const { video, pageWindow } = youTubePage('AAA');
    executeContentScript(JSON.stringify({
      video_0: { paused: true, currentTime: 0, src: 'blob:https://www.youtube.com/old', isYouTube: true },
      youtube_player_state: { paused: true, videoId: 'AAA' }
    }), pageWindow);

    expect(video.pause).not.toHaveBeenCalled();
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
