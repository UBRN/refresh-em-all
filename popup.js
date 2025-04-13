document.getElementById('refreshAll').addEventListener('click', () => {
    chrome.tabs.query({}, (tabs) => {
        for (let tab of tabs) {
            if (tab.id) {
                // Check if tab is discarded (dormant)
                if (tab.discarded) {
                    // For discarded tabs, we need to activate them first
                    chrome.tabs.update(tab.id, { active: true }, () => {
                        // Then reload without cache
                        chrome.tabs.reload(tab.id, { bypassCache: true });
                    });
                } else {
                    // For active tabs, we'll use a custom reload approach
                    chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        function: preserveMediaState,
                    }).then(() => {
                        chrome.tabs.reload(tab.id, { bypassCache: true });
                    }).catch(() => {
                        // Fallback for tabs where we can't execute scripts
                        chrome.tabs.reload(tab.id, { bypassCache: true });
                    });
                }
            }
        }
    });
});

// Function to save media playback state before refresh
function preserveMediaState() {
    // Store playback states in sessionStorage
    const videos = document.querySelectorAll('video');
    const audios = document.querySelectorAll('audio');
    
    const mediaStates = {};
    
    videos.forEach((video, index) => {
        mediaStates[`video_${index}`] = {
            paused: video.paused,
            currentTime: video.currentTime,
            src: video.src
        };
    });
    
    audios.forEach((audio, index) => {
        mediaStates[`audio_${index}`] = {
            paused: audio.paused,
            currentTime: audio.currentTime,
            src: audio.src
        };
    });
    
    // Save state to sessionStorage
    sessionStorage.setItem('refreshEmAllMediaState', JSON.stringify(mediaStates));
}
