const CHECK_INTERVAL_MINUTES = 2;

// Set up alarm when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkNotifications', {
    delayInMinutes: 1,
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });
  
  // Set badge color once
  chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
  
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

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

async function checkNotifications() {
  try {
    const { githubToken, cachedNotifications } = await chrome.storage.local.get(['githubToken', 'cachedNotifications']);
    
    if (!githubToken) {
      updateBadge(0);
      return;
    }
    
    // Update badge from cached count (popup does the real filtering)
    const count = cachedNotifications?.length || 0;
    updateBadge(count);
    
  } catch (err) {
    console.error('Error checking notifications:', err);
  }
}
