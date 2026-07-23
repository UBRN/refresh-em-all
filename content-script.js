// Restore media state captured immediately before Refresh Em All reloaded the tab.
(function restoreRefreshEmAllMediaState() {
    const storageKey = 'refreshEmAllMediaState';
    let mediaStates;

    try {
        const savedState = sessionStorage.getItem(storageKey);
        if (!savedState) return;

        mediaStates = JSON.parse(savedState);
        if (!mediaStates || typeof mediaStates !== 'object' || Array.isArray(mediaStates)) {
            throw new Error('Saved media state has an invalid shape');
        }

        sessionStorage.removeItem(storageKey);
    } catch (error) {
        console.error('[Refresh Em All] Unable to read saved media state:', error);
        try {
            sessionStorage.removeItem(storageKey);
        } catch (storageError) {
            // Storage can be unavailable on restricted pages.
        }
        return;
    }

    const restoredElements = new WeakSet();

    function restoreProperty(media, property, value) {
        if (value === undefined) return;
        try {
            media[property] = value;
        } catch (error) {
            console.debug(`[Refresh Em All] Could not restore ${property}:`, error);
        }
    }

    function restorePlayback(media, savedState) {
        if (savedState.paused) {
            media.pause();

            const keepPaused = () => media.pause();
            media.addEventListener('play', keepPaused);
            setTimeout(() => media.removeEventListener('play', keepPaused), 2000);
            return;
        }

        const playPromise = media.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {
                // Autoplay policies can prevent restoration; the other state is still retained.
            });
        }
    }

    function restoreElement(media, savedState) {
        if (!savedState || restoredElements.has(media)) return;
        restoredElements.add(media);

        const applyState = () => {
            const currentTime = Number(savedState.currentTime);
            if (Number.isFinite(currentTime) && currentTime >= 0) {
                restoreProperty(media, 'currentTime', currentTime);
            }

            restoreProperty(media, 'volume', savedState.volume);
            restoreProperty(media, 'muted', savedState.muted);
            restoreProperty(media, 'playbackRate', savedState.playbackRate);
            restorePlayback(media, savedState);
        };

        if (media.readyState >= 1) {
            applyState();
        } else {
            media.addEventListener('loadedmetadata', applyState, { once: true });
        }
    }

    function restoreMedia() {
        try {
            document.querySelectorAll('video').forEach((video, index) => {
                const savedState = mediaStates[`video_${index}`];
                if (!savedState) return;

                const isYouTube = window.location.hostname.includes('youtube.com');
                const sourceMatches = !video.src
                    || video.src === savedState.src
                    || (isYouTube && savedState.isYouTube);

                if (sourceMatches) {
                    restoreElement(video, savedState);
                }
            });

            document.querySelectorAll('audio').forEach((audio, index) => {
                restoreElement(audio, mediaStates[`audio_${index}`]);
            });

            restoreYouTubePlayerState();
        } catch (error) {
            console.error('[Refresh Em All] Unable to restore media state:', error);
        }
    }

    function restoreYouTubePlayerState() {
        if (!window.location.hostname.includes('youtube.com')) return;

        const savedState = mediaStates.youtube_player_state;
        if (!savedState || !savedState.paused) return;

        const currentVideoId = new URLSearchParams(window.location.search).get('v')
            || window.location.pathname.split('/').pop();
        if (savedState.videoId !== currentVideoId) return;

        const player = document.querySelector('.html5-video-player');
        const video = player?.querySelector('video');
        if (video && !video.paused) video.pause();
    }

    restoreMedia();

    if (document.readyState !== 'complete') {
        window.addEventListener('load', () => setTimeout(restoreMedia, 500), { once: true });
    }

    const observer = new MutationObserver((mutations) => {
        const hasNewMedia = mutations.some(mutation =>
            Array.from(mutation.addedNodes).some(node =>
                node.nodeName === 'VIDEO'
                || node.nodeName === 'AUDIO'
                || (node.querySelector && node.querySelector('video, audio'))
            )
        );

        if (hasNewMedia) restoreMedia();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
})();
