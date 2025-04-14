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