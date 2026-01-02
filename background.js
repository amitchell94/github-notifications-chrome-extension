// Import shared notification loading logic
importScripts('shared.js');

const DEFAULT_CHECK_INTERVAL_MINUTES = 2; // Default if GitHub doesn't specify

// Update alarm interval based on stored poll interval from GitHub
async function updateAlarmInterval() {
  const { pollIntervalMinutes } = await chrome.storage.local.get('pollIntervalMinutes');
  const intervalMinutes = pollIntervalMinutes || DEFAULT_CHECK_INTERVAL_MINUTES;
  
  // Update or create the alarm with the current interval
  chrome.alarms.create('checkNotifications', {
    delayInMinutes: 1,
    periodInMinutes: intervalMinutes
  });
}

// Set up alarm when extension is installed or updated
chrome.runtime.onInstalled.addListener(async () => {
  await updateAlarmInterval();
  
  // Set badge color once
  chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
  
  // Check immediately on install
  checkNotifications();
});

// Also check when browser starts
chrome.runtime.onStartup.addListener(async () => {
  await updateAlarmInterval();
  checkNotifications();
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkNotifications') {
    checkNotifications();
  }
});

// Handle notification clicks
chrome.notifications.onClicked.addListener(async (notificationId) => {
  // Extract the GitHub notification ID from our notification ID
  const githubNotifId = notificationId.replace('github-', '');
  
  // Get the stored URL for this notification
  const { [`notif_url_${githubNotifId}`]: url } = await chrome.storage.local.get(`notif_url_${githubNotifId}`);
  
  if (url) {
    // Open the notification in a new tab
    await chrome.tabs.create({ url });
    
    // Clear the notification
    chrome.notifications.clear(notificationId);
  }
});

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

async function checkNotifications() {
  try {
    const { githubToken, lastSeenIds, pollIntervalMinutes, currentUser, autoMarkTeamReviews, enableSystemNotifications } = await chrome.storage.local.get([
      'githubToken', 
      'lastSeenIds',
      'pollIntervalMinutes',
      'currentUser',
      'autoMarkTeamReviews',
      'enableSystemNotifications'
    ]);
    
    if (!githubToken) {
      updateBadge(0);
      return;
    }
    
    // Update alarm interval if poll interval changed (popup.js may have updated it)
    if (pollIntervalMinutes) {
      const currentAlarm = await chrome.alarms.get('checkNotifications');
      if (!currentAlarm || currentAlarm.periodInMinutes !== pollIntervalMinutes) {
        await updateAlarmInterval();
      }
    }
    
    // Fetch fresh notifications from GitHub API
    const result = await loadNotifications(githubToken, currentUser, { autoMarkTeamReviews });
    const notifications = result.notifications;
    
    // Store current user if not already stored
    if (result.currentUser && !currentUser) {
      await chrome.storage.local.set({ currentUser: result.currentUser });
    }
    
    // Update badge with actual count
    updateBadge(notifications.length);
    
    // Detect new notifications and send system notifications (if enabled)
    if (notifications && notifications.length > 0) {
      const currentIds = notifications.map(n => n.id);
      const previousIds = lastSeenIds || [];
      
      // Find notifications that are new since last check
      const newNotifications = notifications.filter(n => !previousIds.includes(n.id));
      
      // Only send notifications if we have a previous state (not on first load) and setting is enabled
      if (previousIds.length > 0 && newNotifications.length > 0 && enableSystemNotifications !== false) {
        // Send system notifications for new items (limit to 3 to avoid spam)
        const toNotify = newNotifications.slice(0, 3);
        for (const notification of toNotify) {
          await createSystemNotification(notification);
        }
        
        // If there are more than 3 new notifications, show a summary
        if (newNotifications.length > 3) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon48.png',
            title: 'GitHub Notifications',
            message: `${newNotifications.length - 3} more new notifications`,
            priority: 1
          });
        }
      }
      
      // Update last seen IDs
      await chrome.storage.local.set({ lastSeenIds: currentIds });
    } else {
      // No notifications, clear badge
      updateBadge(0);
    }
    
  } catch (err) {
    console.error('Error checking notifications:', err);
    // Don't update badge on error to avoid clearing it unnecessarily
  }
}

async function createSystemNotification(notification) {
  const title = `${getTypeLabel(notification.type)}: ${notification.title}`;
  let message = notification.repo;
  
  // Add context about who triggered this and why
  if (notification.activityAuthor) {
    message = `@${notification.activityAuthor} - ${formatReason(notification.specificReason || notification.reason)}\n${notification.repo}`;
  } else if (notification.author) {
    message = `@${notification.author} - ${formatReason(notification.reason)}\n${notification.repo}`;
  } else {
    message = `${formatReason(notification.reason)}\n${notification.repo}`;
  }
  
  const notificationId = `github-${notification.id}`;
  
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icon48.png',
    title: title,
    message: message,
    priority: 2,
    requireInteraction: false
  });
  
  // Store the URL for this notification so we can open it on click
  await chrome.storage.local.set({ [`notif_url_${notification.id}`]: notification.webUrl });
}

function getTypeLabel(type) {
  switch (type) {
    case 'PullRequest': return 'PR';
    case 'Issue': return 'Issue';
    case 'Release': return 'Release';
    default: return type;
  }
}

function formatReason(reason) {
  const reasons = {
    'review_requested': 'Review requested',
    'mention': 'Mentioned',
    'author': 'Author',
    'comment': 'Comment',
    'subscribed': 'Watching',
    'approved': 'Approved',
    'changes_requested': 'Changes requested',
    'reviewed': 'Reviewed',
    'commented': 'Commented',
  };
  return reasons[reason] || reason;
}
