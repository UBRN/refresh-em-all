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
    const isYouTube = window.location.hostname.includes('youtube.com');

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
            // Paused at the very start means the user never played it: leave the
            // page's own autoplay alone instead of holding it paused.
            if (!(Number(savedState.currentTime) > 0)) return;
            media.pause();

            const keepPaused = () => media.pause();
            media.addEventListener('play', keepPaused);
            setTimeout(() => media.removeEventListener('play', keepPaused), 2000);
            return;
        }

        // Autoplay policies can prevent restoration; the other state is still retained.
        media.play().catch(() => {});
    }

    function restoreElement(media, savedState) {
        if (restoredElements.has(media)) return;
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

    // An element that picks its resource through a <source> child reports an empty .src,
    // so use .currentSrc (the resolved resource) and fall back to .src. A <source>-child
    // element whose resource selection has not run yet has both empty and is restored
    // without the source check.
    function mediaSource(media) {
        return media.currentSrc || media.src;
    }

    // YouTube reuses one video element for every video, so its saved state applies only
    // while the page still shows the video it was saved from.
    function sameYouTubeVideo() {
        const currentVideoId = new URLSearchParams(window.location.search).get('v')
            || window.location.pathname.split('/').pop();
        return mediaStates.youtube_player_state?.videoId === currentVideoId;
    }

    function restoreMedia() {
        for (const kind of ['video', 'audio']) {
            document.querySelectorAll(kind).forEach((media, index) => {
                const savedState = mediaStates[`${kind}_${index}`];
                if (!savedState) return;

                const source = mediaSource(media);
                // Only video states carry isYouTube.
                const sourceMatches = !source
                    || source === savedState.src
                    || (isYouTube && savedState.isYouTube && sameYouTubeVideo());

                if (sourceMatches) {
                    restoreElement(media, savedState);
                }
            });
        }

        restoreYouTubePlayerState();
    }

    function restoreYouTubePlayerState() {
        if (!isYouTube) return;

        const savedState = mediaStates.youtube_player_state;
        if (!savedState || !savedState.paused || !sameYouTubeVideo()) return;
        // Paused at the very start means the user never played it; see restorePlayback.
        if (!(Number(mediaStates.video_0?.currentTime) > 0)) return;

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
