// Configuration constants
const NOTIFICATION_REMOVAL_ANIMATION_MS = 200;

let currentUser = null;

// DOM Elements
const settingsView = document.getElementById('settings-view');
const notificationsView = document.getElementById('notifications-view');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const listEl = document.getElementById('notifications-list');
const tokenInput = document.getElementById('token-input');
const autoMarkTeamReviewsCheckbox = document.getElementById('auto-mark-team-reviews');
const enableSystemNotificationsCheckbox = document.getElementById('enable-system-notifications');
const saveTokenBtn = document.getElementById('save-token-btn');
const settingsBtn = document.getElementById('settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const refreshBtn = document.getElementById('refresh-btn');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const { githubToken, cachedNotifications, cachedAt } = await chrome.storage.local.get([
    'githubToken',
    'cachedNotifications', 
    'cachedAt'
  ]);
  
  if (githubToken) {
    showNotificationsView();
    
    // Show cached notifications immediately if available
    if (cachedNotifications && cachedNotifications.length > 0) {
      const notifications = cachedNotifications.map(n => ({
        ...n,
        updatedAt: new Date(n.updatedAt),
        lastReadAt: n.lastReadAt ? new Date(n.lastReadAt) : null,
        newActivities: (n.newActivities || []).map(a => ({
          ...a,
          createdAt: new Date(a.createdAt)
        }))
      }));
      renderNotifications(notifications);
      showList();
      
      // Fetch fresh in background
      loadNotificationsUI(githubToken, true);
    } else {
      loadNotificationsUI(githubToken, false);
    }
  } else {
    showSettingsView();
  }
});

// Event listeners
saveTokenBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;
  
  const autoMarkTeamReviews = autoMarkTeamReviewsCheckbox.checked;
  const enableSystemNotifications = enableSystemNotificationsCheckbox.checked;
  
  // Clear cache when token changes
  await chrome.storage.local.set({ 
    githubToken: token, 
    autoMarkTeamReviews,
    enableSystemNotifications,
    cachedNotifications: null, 
    cachedAt: null 
  });
  showNotificationsView();
  loadNotificationsUI(token, false);
});

settingsBtn.addEventListener('click', async () => {
  const { githubToken, autoMarkTeamReviews, enableSystemNotifications } = await chrome.storage.local.get(['githubToken', 'autoMarkTeamReviews', 'enableSystemNotifications']);
  tokenInput.value = githubToken || '';
  autoMarkTeamReviewsCheckbox.checked = autoMarkTeamReviews !== false; // Default to true
  enableSystemNotificationsCheckbox.checked = enableSystemNotifications !== false; // Default to true
  showSettingsView();
});

closeSettingsBtn.addEventListener('click', () => {
  showNotificationsView();
});

refreshBtn.addEventListener('click', async () => {
  const { githubToken } = await chrome.storage.local.get('githubToken');
  if (githubToken) {
    // Keep existing notifications visible while refreshing
    const hasExisting = listEl.children.length > 0;
    loadNotificationsUI(githubToken, false, hasExisting);
  }
});

// View management
function showSettingsView() {
  settingsView.classList.remove('hidden');
  notificationsView.classList.add('hidden');
}

function showNotificationsView() {
  settingsView.classList.add('hidden');
  notificationsView.classList.remove('hidden');
}

function showLoading(keepExisting = false) {
  if (!keepExisting) {
    loadingEl.style.display = 'flex';
    listEl.innerHTML = '';
  } else {
    // Show subtle loading state - dim the list and show spinner on refresh button
    listEl.style.opacity = '0.5';
    refreshBtn.classList.add('loading');
  }
  errorEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
}

function showError(message) {
  loadingEl.style.display = 'none';
  listEl.style.opacity = '1';
  refreshBtn.classList.remove('loading');
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function showEmpty() {
  loadingEl.style.display = 'none';
  listEl.style.opacity = '1';
  refreshBtn.classList.remove('loading');
  emptyEl.classList.remove('hidden');
  listEl.innerHTML = '';
}

function showList() {
  loadingEl.style.display = 'none';
  listEl.style.opacity = '1';
  refreshBtn.classList.remove('loading');
  emptyEl.classList.add('hidden');
}

async function loadNotificationsUI(token, isBackground = false, keepExisting = false) {
  if (!isBackground) {
    showLoading(keepExisting);
  }
  
  try {
    // Get current user and settings from storage
    const { currentUser: storedUser, autoMarkTeamReviews } = await chrome.storage.local.get(['currentUser', 'autoMarkTeamReviews']);
    
    // Use shared module to load notifications (loadNotifications is globally available from shared.js)
    const result = await loadNotifications(token, storedUser, { autoMarkTeamReviews });
    const notifications = result.notifications;
    
    // Store current user if not already stored
    if (result.currentUser && !storedUser) {
      await chrome.storage.local.set({ currentUser: result.currentUser });
    }
    
    // Render results
    if (notifications.length === 0) {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
      if (!isBackground) {
        showEmpty();
      }
      return;
    }
    
    // Render final results
    renderNotifications(notifications);
    showList();
    
    // Update badge to reflect actual filtered count
    const badgeCount = notifications.length;
    chrome.action.setBadgeText({ text: badgeCount > 0 ? String(badgeCount) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
    
  } catch (err) {
    console.error('Failed to load notifications:', err);
    if (!isBackground) {
      // Show user-friendly error messages
      if (err.message.includes('Authentication failed') || err.message.includes('401')) {
        showError('Invalid token. Please check your GitHub token in settings.');
      } else if (err.message.includes('Network error') || err.message.includes('Failed to fetch')) {
        showError('Unable to connect to GitHub. Please check your internet connection.');
      } else if (err.message.includes('Access forbidden') || err.message.includes('403')) {
        showError('Token lacks required permissions. Please create a new token with "notifications" scope.');
      } else {
        showError(`Failed to load notifications: ${err.message}`);
      }
    }
  }
}

// Track pending removals to prevent race conditions
const pendingRemovals = new Set();

function renderNotifications(notifications) {
  emptyEl.classList.add('hidden');
  listEl.innerHTML = notifications.map(n => {
    const displayReason = n.specificReason || n.reason;
    const reasonClass = getReasonClass(displayReason, n.reason === 'review_requested' && !n.isTeamReview);
    const actorDisplay = n.activityAuthor || n.author;
    
    return `
    <li class="notification-item" data-url="${escapeHtml(n.webUrl)}" data-id="${escapeHtml(n.id)}">
      <div class="notification-content">
        <div class="notification-header">
          <span class="notification-type ${getTypeClass(n.type)}">${getTypeLabel(n.type)}</span>
          <span class="notification-repo">${escapeHtml(n.repo)}</span>
        </div>
        <div class="notification-title">${escapeHtml(n.title)}</div>
        <div class="notification-meta">
          ${actorDisplay ? `<span class="notification-author">@${escapeHtml(actorDisplay)}</span>` : ''}
          <span class="notification-reason ${reasonClass}">${formatReason(displayReason)}</span>
          <span class="notification-time">${formatTime(n.updatedAt)}</span>
        </div>
      </div>
      <button class="done-btn" title="Mark as done">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
        </svg>
      </button>
    </li>
  `;
  }).join('');
  
  // Add click handlers for opening notification
  listEl.querySelectorAll('.notification-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't open URL if clicking the done button
      if (e.target.closest('.done-btn')) return;
      
      const url = item.dataset.url;
      if (url) {
        chrome.tabs.create({ url });
      }
    });
  });
  
  // Add click handlers for done button
  listEl.querySelectorAll('.done-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = btn.closest('.notification-item');
      const threadId = item.dataset.id;
      
      // Prevent duplicate removals
      if (pendingRemovals.has(threadId)) {
        return;
      }
      pendingRemovals.add(threadId);
      
      // Add loading state
      btn.classList.add('loading');
      btn.disabled = true;
      
      const { githubToken } = await chrome.storage.local.get('githubToken');
      const success = await markNotificationAsDone(threadId, githubToken);
      
      if (success) {
        // Animate out and remove
        item.style.transform = 'translateX(100%)';
        item.style.opacity = '0';
        setTimeout(() => {
          item.remove();
          pendingRemovals.delete(threadId);
          // Update cache
          updateCacheAfterDone(threadId);
          // Check if list is empty
          if (listEl.children.length === 0) {
            showEmpty();
          }
        }, NOTIFICATION_REMOVAL_ANIMATION_MS);
      } else {
        btn.classList.remove('loading');
        btn.disabled = false;
        pendingRemovals.delete(threadId);
      }
    });
  });
}

async function updateCacheAfterDone(threadId) {
  const { cachedNotifications } = await chrome.storage.local.get('cachedNotifications');
  if (cachedNotifications) {
    const updated = cachedNotifications.filter(n => n.id !== threadId);
    await chrome.storage.local.set({ cachedNotifications: updated });
    // Update badge
    chrome.action.setBadgeText({ text: updated.length > 0 ? String(updated.length) : '' });
  }
}

// Helpers
function getTypeClass(type) {
  switch (type) {
    case 'PullRequest': return 'pr';
    case 'Issue': return 'issue';
    case 'Release': return 'release';
    default: return 'other';
  }
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
    'assign': 'Assigned',
    'subscribed': 'Subscribed',
    'state_change': 'State change',
    'ci_activity': 'CI activity',
    'team_mention': 'Team mention',
    // Specific author notification reasons
    'approved': 'Approved',
    'changes_requested': 'Changes requested',
    'reviewed': 'Reviewed',
    'commented': 'Commented',
    'review_comment': 'Code comment',
    'pushed': 'Pushed',
  };
  return reasons[reason] || reason;
}

function getReasonClass(reason, isDirectReview) {
  // Return CSS class for styling specific reasons
  if (isDirectReview) return 'direct';
  if (reason === 'approved' || reason?.includes('approval')) return 'approved';
  if (reason === 'changes_requested') return 'changes-requested';
  if (reason === 'reviewed' || reason === 'review_comment' || reason?.includes('review')) return 'reviewed';
  if (reason === 'commented' || reason?.includes('comment')) return 'commented';
  return '';
}

function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
