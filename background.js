const CHECK_INTERVAL_MINUTES = 2;

// Set up alarm when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkNotifications', {
    delayInMinutes: 1,
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });
  
  // Check immediately on install
  checkNotifications();
});

// Also check when browser starts
chrome.runtime.onStartup.addListener(() => {
  checkNotifications();
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkNotifications') {
    checkNotifications();
  }
});

async function checkNotifications() {
  try {
    const { githubToken, cachedNotifications } = await chrome.storage.local.get(['githubToken', 'cachedNotifications']);
    
    if (!githubToken) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    
    // Update badge from cached count (popup does the real filtering)
    const count = cachedNotifications?.length || 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
    
  } catch (err) {
    console.error('Error checking notifications:', err);
  }
}

