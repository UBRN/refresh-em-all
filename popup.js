document.getElementById('refreshAll').addEventListener('click', () => {
    chrome.tabs.query({}, (tabs) => {
        for (let tab of tabs) {
            if (tab.id) {
                chrome.tabs.reload(tab.id, { bypassCache: true });
            }
        }
    });
});
