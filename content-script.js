// This script runs on page load to restore media playback states
(function() {
    try {
        // Check if we have saved media states
        const savedStates = sessionStorage.getItem('refreshEmAllMediaState');
        
        if (savedStates) {
            const mediaStates = JSON.parse(savedStates);
            
            // Clear the saved state right away to avoid applying it multiple times
            sessionStorage.removeItem('refreshEmAllMediaState');
            
            // Function to restore video/audio states
            const restoreMedia = () => {
                // Handle videos
                const videos = document.querySelectorAll('video');
                videos.forEach((video, index) => {
                    const savedState = mediaStates[`video_${index}`];
                    if (savedState && video.src === savedState.src) {
                        video.currentTime = savedState.currentTime;
                        
                        // If it was paused, keep it paused
                        if (savedState.paused) {
                            video.pause();
                        }
                    }
                });
                
                // Handle audios
                const audios = document.querySelectorAll('audio');
                audios.forEach((audio, index) => {
                    const savedState = mediaStates[`audio_${index}`];
                    if (savedState && audio.src === savedState.src) {
                        audio.currentTime = savedState.currentTime;
                        
                        // If it was paused, keep it paused
                        if (savedState.paused) {
                            audio.pause();
                        }
                    }
                });
            };
            
            // Try to restore immediately for media elements already in the DOM
            restoreMedia();
            
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
        }
    } catch (error) {
        console.error("Error in Refresh Em All content script:", error);
    }
})(); 