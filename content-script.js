// This script runs on page load to restore media playback states
(function() {
    try {
        // Error handling for content script
        window.addEventListener('error', (event) => {
            const errorDetails = {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: event.error ? event.error.stack : null,
                timestamp: new Date().toISOString(),
                context: 'content_script',
                url: window.location.href,
                pageTitle: document.title
            };
            
            chrome.runtime.sendMessage({
                action: 'reportError',
                errorType: 'content_script_error',
                errorDetails
            });
        });
        
        // Check if we have saved media states
        const savedStates = sessionStorage.getItem('refreshEmAllMediaState');
        
        if (savedStates) {
            const mediaStates = JSON.parse(savedStates);
            
            // Clear the saved state right away to avoid applying it multiple times
            sessionStorage.removeItem('refreshEmAllMediaState');
            
            // Function to restore video/audio states
            const restoreMedia = () => {
                try {
                    // Handle videos
                    const videos = document.querySelectorAll('video');
                    videos.forEach((video, index) => {
                        const savedState = mediaStates[`video_${index}`];
                        if (savedState) {
                            // Special handling for YouTube
                            const isYoutube = window.location.hostname.includes('youtube.com');
                            
                            // For YouTube or when source matches
                            if ((isYoutube && savedState.isYouTube) || 
                                video.src === savedState.src || 
                                !video.src) {  // Handle srcless videos
                                
                                // Only restore if the video was visible before refresh
                                // or if we're on YouTube (which has special handling)
                                if (savedState.isVisible || isYoutube) {
                                    // Set time position only if video has loaded metadata
                                    const setCurrentTime = () => {
                                        if (video.readyState >= 1) {
                                            video.currentTime = savedState.currentTime;
                                        } else {
                                            // If metadata not loaded, wait and try again
                                            video.addEventListener('loadedmetadata', () => {
                                                video.currentTime = savedState.currentTime;
                                            }, { once: true });
                                        }
                                    };
                                    
                                    setCurrentTime();
                                    
                                    // Set other properties if available
                                    if (savedState.volume !== undefined) video.volume = savedState.volume;
                                    if (savedState.muted !== undefined) video.muted = savedState.muted;
                                    if (savedState.playbackRate !== undefined) video.playbackRate = savedState.playbackRate;
                                    
                                    // Force pause if it was paused before
                                    if (savedState.paused) {
                                        video.pause();
                                        
                                        // Add multiple pause events to prevent auto-play scripts
                                        // This helps with sites that try to restart videos
                                        const ensurePaused = () => {
                                            if (!video.paused) video.pause();
                                        };
                                        
                                        // Immediate pause
                                        ensurePaused();
                                        
                                        // Continue checking for a short period
                                        for (let i = 0; i < 5; i++) {
                                            setTimeout(ensurePaused, 50 * i);
                                        }
                                        
                                        // Also pause after any play event
                                        video.addEventListener('play', function pauseHandler(e) {
                                            video.pause();
                                            // Remove after a while to avoid permanently breaking playback
                                            setTimeout(() => {
                                                video.removeEventListener('play', pauseHandler);
                                            }, 2000);
                                        });
                                    }
                                }
                            }
                        }
                    });
                    
                    // YouTube-specific handling with improved reliability
                    if (window.location.hostname.includes('youtube.com') && mediaStates['youtube_player_state']) {
                        const ytState = mediaStates['youtube_player_state'];
                        
                        // Verify we're on the same video
                        const currentVideoId = new URLSearchParams(window.location.search).get('v') || 
                                               window.location.pathname.split('/').pop();
                        
                        if (ytState.videoId === currentVideoId) {
                            // Find the YouTube player
                            const player = document.querySelector('.html5-video-player');
                            if (player && ytState.paused) {
                                // Try multiple approaches to pause the YouTube player
                                const pausePlayer = () => {
                                    // Try to pause through YouTube's own interface
                                    const pauseButton = document.querySelector('.ytp-play-button');
                                    if (pauseButton && player.classList.contains('playing-mode')) {
                                        pauseButton.click();
                                    }
                                    
                                    // Also try to pause the actual video element directly
                                    const videoElement = player.querySelector('video');
                                    if (videoElement && !videoElement.paused) {
                                        videoElement.pause();
                                    }
                                };
                                
                                // Try immediately
                                pausePlayer();
                                
                                // And also after a short delay to handle dynamic loading
                                setTimeout(pausePlayer, 500);
                                setTimeout(pausePlayer, 1000);
                            }
                        }
                    }
                    
                    // Handle audios
                    const audios = document.querySelectorAll('audio');
                    audios.forEach((audio, index) => {
                        const savedState = mediaStates[`audio_${index}`];
                        if (savedState) {
                            // Set time position
                            audio.currentTime = savedState.currentTime;
                            
                            // Set other properties if available
                            if (savedState.volume !== undefined) audio.volume = savedState.volume;
                            if (savedState.muted !== undefined) audio.muted = savedState.muted;
                            if (savedState.playbackRate !== undefined) audio.playbackRate = savedState.playbackRate;
                            
                            // Force pause if it was paused before
                            if (savedState.paused) {
                                audio.pause();
                                
                                // Similar to video, prevent auto-play
                                audio.addEventListener('play', function pauseHandler(e) {
                                    audio.pause();
                                    setTimeout(() => {
                                        audio.removeEventListener('play', pauseHandler);
                                    }, 2000);
                                });
                            }
                        }
                    });
                } catch (error) {
                    // Report specific error in media restoration
                    chrome.runtime.sendMessage({
                        action: 'reportError',
                        errorType: 'media_restoration_error',
                        errorDetails: {
                            message: error.message,
                            stack: error.stack,
                            timestamp: new Date().toISOString(),
                            url: window.location.href,
                            pageTitle: document.title
                        }
                    });
                }
            };
            
            // Try to restore immediately for media elements already in the DOM
            restoreMedia();
            
            // Also attempt restoration after the page has fully loaded
            if (document.readyState !== 'complete') {
                window.addEventListener('load', () => {
                    setTimeout(restoreMedia, 500); // Slight delay to allow dynamic content to load
                }, { once: true });
            }
            
            // Also set up a MutationObserver to handle dynamically loaded media elements
            const observer = new MutationObserver((mutations) => {
                let hasNewMedia = false;
                
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO' ||
                                (node.querySelectorAll && 
                                (node.querySelectorAll('video').length > 0 || 
                                 node.querySelectorAll('audio').length > 0))) {
                                hasNewMedia = true;
                                break;
                            }
                        }
                    }
                }
                
                if (hasNewMedia) {
                    restoreMedia();
                }
            });
            
            // Start observing the document
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
            
            // Stop the observer after a reasonable time (10 seconds)
            setTimeout(() => {
                observer.disconnect();
            }, 10000);
            
            // Show success notification
            showRefreshSuccessNotification();
            
            // Report successful refresh
            chrome.runtime.sendMessage({
                action: 'reportError',
                errorType: 'tab_refresh_success',
                errorDetails: {
                    timestamp: new Date().toISOString(),
                    url: window.location.href,
                    pageTitle: document.title,
                    mediaRestored: Object.keys(mediaStates).length > 0
                }
            });
        }
    } catch (error) {
        console.error("Error in Refresh Em All content script:", error);
        
        // Report the caught error
        chrome.runtime.sendMessage({
            action: 'reportError',
            errorType: 'content_script_exception',
            errorDetails: {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString(),
                url: window.location.href,
                pageTitle: document.title
            }
        });
    }
})();

// Function to show a temporary success notification
function showRefreshSuccessNotification() {
    try {
        // Create notification element
        const notification = document.createElement('div');
        
        // Style the notification
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            backgroundColor: '#0f9d58',
            color: 'white',
            padding: '10px 15px',
            borderRadius: '4px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            zIndex: '9999',
            display: 'flex',
            alignItems: 'center',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            opacity: '0',
            transition: 'opacity 0.3s ease'
        });
        
        // Create checkmark icon
        const checkmark = document.createElement('div');
        checkmark.innerHTML = '✓';
        Object.assign(checkmark.style, {
            marginRight: '8px',
            fontSize: '18px',
            fontWeight: 'bold'
        });
        
        // Add text and checkmark
        notification.appendChild(checkmark);
        notification.appendChild(document.createTextNode('Tab refreshed successfully'));
        
        // Add to document
        document.body.appendChild(notification);
        
        // Fade in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);
        
        // Fade out and remove after 3 seconds
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    } catch (error) {
        // Report notification error but don't break functionality
        chrome.runtime.sendMessage({
            action: 'reportError',
            errorType: 'notification_error',
            errorDetails: {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString(),
                url: window.location.href,
                pageTitle: document.title
            }
        });
    }
} 