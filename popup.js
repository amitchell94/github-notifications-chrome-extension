const API_BASE = 'https://api.github.com';
const HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
};

let currentUser = null;

// DOM Elements
const settingsView = document.getElementById('settings-view');
const notificationsView = document.getElementById('notifications-view');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const listEl = document.getElementById('notifications-list');
const tokenInput = document.getElementById('token-input');
const saveTokenBtn = document.getElementById('save-token-btn');
const settingsBtn = document.getElementById('settings-btn');
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
      loadNotifications(githubToken, true);
    } else {
      loadNotifications(githubToken, false);
    }
  } else {
    showSettingsView();
  }
});

// Event listeners
saveTokenBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;
  
  // Clear cache when token changes
  await chrome.storage.local.set({ githubToken: token, cachedNotifications: null, cachedAt: null });
  showNotificationsView();
  loadNotifications(token, false);
});

settingsBtn.addEventListener('click', async () => {
  const { githubToken } = await chrome.storage.local.get('githubToken');
  tokenInput.value = githubToken || '';
  showSettingsView();
});

refreshBtn.addEventListener('click', async () => {
  const { githubToken } = await chrome.storage.local.get('githubToken');
  if (githubToken) {
    // Keep existing notifications visible while refreshing
    const hasExisting = listEl.children.length > 0;
    loadNotifications(githubToken, false, hasExisting);
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

// API calls
async function fetchWithAuth(url, token) {
  const response = await fetch(url, {
    headers: {
      ...HEADERS,
      'Authorization': `Bearer ${token}`
    },
    cache: 'no-store'
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  
  return response.json();
}

async function markNotificationAsRead(threadId, token) {
  const response = await fetch(`${API_BASE}/notifications/threads/${threadId}`, {
    method: 'PATCH',
    headers: {
      ...HEADERS,
      'Authorization': `Bearer ${token}`
    }
  });
  
  // 205 Reset Content = success, 304 Not Modified = already read
  return response.status === 205 || response.status === 304;
}

async function markNotificationAsDone(threadId, token) {
  const response = await fetch(`${API_BASE}/notifications/threads/${threadId}`, {
    method: 'DELETE',
    headers: {
      ...HEADERS,
      'Authorization': `Bearer ${token}`
    }
  });
  
  // 204 No Content = success
  return response.status === 204;
}

async function loadNotifications(token, isBackground = false, keepExisting = false) {
  console.log('[GH Notif] === loadNotifications called ===', { isBackground, keepExisting, tokenPrefix: token?.substring(0, 10) + '...' });
  
  if (!isBackground) {
    showLoading(keepExisting);
  }
  
  try {
    // Get current user first
    if (!currentUser) {
      const user = await fetchWithAuth(`${API_BASE}/user`, token);
      currentUser = user.login;
      console.log('[GH Notif] Current user:', currentUser);
    }
    
    // Get notifications
    console.log('[GH Notif] Fetching notifications...');
    const notifications = await fetchWithAuth(
      `${API_BASE}/notifications?per_page=100`,
      token
    );
    
    console.log('[GH Notif] Raw notifications from API (count=' + notifications.length + '):', notifications.map(n => ({
      id: n.id,
      reason: n.reason,
      type: n.subject.type,
      title: n.subject.title,
      updated_at: n.updated_at,
      last_read_at: n.last_read_at
    })));
    
    if (notifications.length === 0) {
      await chrome.storage.local.set({ cachedNotifications: [], cachedAt: Date.now() });
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
      if (!isBackground) {
        showEmpty();
      }
      return;
    }
    
    // Only show notifications we care about:
    // - review_requested (direct only, filtered later)
    // - author (activity on your PRs/issues)
    // - mention (someone @mentioned you)
    // - comment (replies to threads you commented on)
    const allowedReasons = ['review_requested', 'author', 'mention', 'comment'];
    
    const filteredOutByReason = notifications.filter(n => !allowedReasons.includes(n.reason));
    if (filteredOutByReason.length > 0) {
      console.log('[GH Notif] Filtered OUT by reason:', filteredOutByReason.map(n => ({
        reason: n.reason,
        type: n.subject.type,
        title: n.subject.title
      })));
    }
    
    // Quick parse - show notifications immediately without details
    const quickNotifications = notifications
      .filter(n => allowedReasons.includes(n.reason))
      .map(n => ({
        id: n.id,
        repo: n.repository.full_name,
        title: n.subject.title,
        type: n.subject.type,
        reason: n.reason,
        specificReason: null, // Will be populated for author notifications
        updatedAt: new Date(n.updated_at),
        lastReadAt: n.last_read_at ? new Date(n.last_read_at) : null, // When user last viewed this
        url: n.subject.url,
        latestCommentUrl: n.subject.latest_comment_url, // For determining specific activity
        webUrl: n.subject.url
          ? n.subject.url.replace('api.github.com/repos', 'github.com').replace('/pulls/', '/pull/')
          : n.repository.html_url,
        author: null,
        activityAuthor: null, // Who triggered this notification
        newActivities: [], // Array of new activities since last_read_at
        isDirect: true,
        isTeamReview: false,
        detailsLoaded: false
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt); // Most recent first
    
    // Now fetch details
    const detailedNotifications = [...quickNotifications];
    
    // Process in batches of 5 for speed
    const batchSize = 5;
    for (let i = 0; i < detailedNotifications.length; i += batchSize) {
      const batch = detailedNotifications.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (notification) => {
        if (!notification.url) return;
        
        try {
          const details = await fetchWithAuth(notification.url, token);
          notification.author = details.user?.login;
          notification.detailsLoaded = true;
          
          // Check if it's a team review request
          if (notification.reason === 'review_requested' && notification.type === 'PullRequest') {
            const requestedReviewers = (details.requested_reviewers || []).map(r => r.login);
            if (!requestedReviewers.includes(currentUser)) {
              notification.isTeamReview = true;
              // Auto-mark team review requests as done
              markNotificationAsDone(notification.id, token).catch(() => {});
            }
          }
          
          // For author/comment notifications on PRs, fetch activity since last_read_at
          const needsActivityCheck = 
            (notification.reason === 'author' || notification.reason === 'comment') && 
            notification.type === 'PullRequest';
          
          console.log(`[GH Notif] "${notification.title}" - needsActivityCheck: ${needsActivityCheck}, reason: ${notification.reason}, type: ${notification.type}`);
          
          if (needsActivityCheck) {
            // Skip merged/closed PRs entirely - not interested in these
            if (details.merged || details.state === 'closed') {
              console.log(`[GH Notif] "${notification.title}" - SKIPPED: merged=${details.merged}, state=${details.state}`);
              notification.isClosedOrMerged = true;
              return;
            }
            
            const prNumber = notification.url.match(/\/pulls\/(\d+)$/)?.[1];
            const repoUrl = notification.url.replace(/\/pulls\/\d+$/, '');
            const sinceDate = notification.lastReadAt;
            
            if (prNumber) {
              try {
                // Fetch issue comments (general PR comments)
                const commentsUrl = `${repoUrl}/issues/${prNumber}/comments?per_page=50`;
                const comments = await fetchWithAuth(commentsUrl, token);
                const newComments = sinceDate 
                  ? comments.filter(c => new Date(c.created_at) > sinceDate && c.user?.login !== currentUser)
                  : comments.filter(c => c.user?.login !== currentUser).slice(-5);
                
                for (const comment of newComments) {
                  notification.newActivities.push({
                    type: 'comment',
                    author: comment.user?.login,
                    createdAt: new Date(comment.created_at)
                  });
                }
              } catch (err) {
                console.error(`[GH Notif] "${notification.title}" - Comments fetch FAILED:`, err);
              }
              
              try {
                // Fetch review comments (inline code comments)
                const reviewCommentsUrl = `${repoUrl}/pulls/${prNumber}/comments?per_page=50`;
                const reviewComments = await fetchWithAuth(reviewCommentsUrl, token);
                const newReviewComments = sinceDate
                  ? reviewComments.filter(c => new Date(c.created_at) > sinceDate && c.user?.login !== currentUser)
                  : reviewComments.filter(c => c.user?.login !== currentUser).slice(-5);
                
                for (const comment of newReviewComments) {
                  notification.newActivities.push({
                    type: 'review_comment',
                    author: comment.user?.login,
                    createdAt: new Date(comment.created_at)
                  });
                }
              } catch (err) {
                console.error(`[GH Notif] "${notification.title}" - Review comments fetch FAILED:`, err);
              }
              
              try {
                // Fetch reviews (approvals, changes requested, etc.)
                const reviewsUrl = `${repoUrl}/pulls/${prNumber}/reviews?per_page=50`;
                const reviews = await fetchWithAuth(reviewsUrl, token);
                console.log(`[GH Notif] "${notification.title}" - All reviews:`, reviews.map(r => ({
                  author: r.user?.login,
                  state: r.state,
                  submitted_at: r.submitted_at
                })));
                console.log(`[GH Notif] "${notification.title}" - sinceDate: ${sinceDate}, currentUser: ${currentUser}`);
                
                const newReviews = sinceDate
                  ? reviews.filter(r => new Date(r.submitted_at) > sinceDate && r.user?.login !== currentUser)
                  : reviews.filter(r => r.user?.login !== currentUser).slice(-5);
                
                console.log(`[GH Notif] "${notification.title}" - Filtered reviews (new since lastRead):`, newReviews.map(r => ({
                  author: r.user?.login,
                  state: r.state,
                  submitted_at: r.submitted_at
                })));
                
                for (const review of newReviews) {
                  const state = review.state?.toLowerCase();
                  let reviewType = 'reviewed';
                  if (state === 'approved') reviewType = 'approved';
                  else if (state === 'changes_requested') reviewType = 'changes_requested';
                  else if (state === 'commented') {
                    reviewType = 'reviewed';
                  }
                  
                  notification.newActivities.push({
                    type: reviewType,
                    author: review.user?.login,
                    createdAt: new Date(review.submitted_at)
                  });
                }
              } catch (err) {
                console.error(`[GH Notif] "${notification.title}" - Reviews fetch FAILED:`, err);
              }
            }
            
            // Sort activities by date (newest first) and set summary
            notification.newActivities.sort((a, b) => b.createdAt - a.createdAt);
            
            if (notification.newActivities.length > 0) {
              // Get unique authors
              const authors = [...new Set(notification.newActivities.map(a => a.author).filter(Boolean))];
              notification.activityAuthor = authors.slice(0, 2).join(', ') + (authors.length > 2 ? ` +${authors.length - 2}` : '');
              
              // Build summary of activity types
              const typeCounts = {};
              for (const activity of notification.newActivities) {
                typeCounts[activity.type] = (typeCounts[activity.type] || 0) + 1;
              }
              
              // Prioritize showing the most important activity type
              if (typeCounts.approved) {
                notification.specificReason = typeCounts.approved > 1 ? `${typeCounts.approved} approvals` : 'approved';
              } else if (typeCounts.changes_requested) {
                notification.specificReason = 'changes_requested';
              } else if (typeCounts.reviewed) {
                notification.specificReason = typeCounts.reviewed > 1 ? `${typeCounts.reviewed} reviews` : 'reviewed';
              } else {
                // Count comments
                const commentCount = (typeCounts.comment || 0) + (typeCounts.review_comment || 0);
                if (commentCount > 0) {
                  notification.specificReason = commentCount > 1 ? `${commentCount} comments` : 'commented';
                }
              }
            }
          }
        } catch (err) {
          notification.detailsLoaded = true;
        }
      }));
      
    }
    
    // Final filtered list - render once after all details loaded
    console.log('[GH Notif] Before final filter:', detailedNotifications.map(n => ({
      title: n.title,
      reason: n.reason,
      isTeamReview: n.isTeamReview,
      isClosedOrMerged: n.isClosedOrMerged,
      newActivitiesCount: n.newActivities.length,
      newActivities: n.newActivities
    })));
    
    const finalFiltered = detailedNotifications
      .filter(n => {
        if (n.isTeamReview) {
          console.log(`[GH Notif] "${n.title}" - FILTERED OUT: team review`);
          return false;
        }
        if (n.isClosedOrMerged) {
          console.log(`[GH Notif] "${n.title}" - FILTERED OUT: closed/merged`);
          return false;
        }
        // For author/comment notifications, only show if there's new activity
        if ((n.reason === 'author' || n.reason === 'comment') && n.newActivities.length === 0) {
          console.log(`[GH Notif] "${n.title}" - FILTERED OUT: no new activities (reason: ${n.reason})`);
          return false;
        }
        console.log(`[GH Notif] "${n.title}" - KEPT`);
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    
    // Render final results
    if (finalFiltered.length === 0) {
      showEmpty();
    } else {
      renderNotifications(finalFiltered);
      showList();
    }
    
    // Cache final results
    const toCache = finalFiltered.map(n => ({
      ...n,
      updatedAt: n.updatedAt.toISOString(),
      lastReadAt: n.lastReadAt ? n.lastReadAt.toISOString() : null,
      newActivities: n.newActivities.map(a => ({
        ...a,
        createdAt: a.createdAt.toISOString()
      }))
    }));
    await chrome.storage.local.set({ cachedNotifications: toCache, cachedAt: Date.now() });
    
    // Update badge to reflect actual filtered count
    const badgeCount = finalFiltered.length;
    chrome.action.setBadgeText({ text: badgeCount > 0 ? String(badgeCount) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#a371f7' });
    
  } catch (err) {
    console.error('[GH Notif] ERROR in loadNotifications:', err);
    if (!isBackground) {
      if (err.message.includes('401')) {
        showError('Invalid token. Please check your GitHub token in settings.');
      } else {
        showError(`Failed to load notifications: ${err.message}`);
      }
    }
  }
}

function renderNotifications(notifications) {
  emptyEl.classList.add('hidden');
  listEl.innerHTML = notifications.map(n => {
    const displayReason = n.specificReason || n.reason;
    const reasonClass = getReasonClass(displayReason, n.isDirect && n.reason === 'review_requested');
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
          // Update cache
          updateCacheAfterDone(threadId);
          // Check if list is empty
          if (listEl.children.length === 0) {
            showEmpty();
          }
        }, 200);
      } else {
        btn.classList.remove('loading');
        btn.disabled = false;
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

function getReasonClass(reason, isDirect) {
  // Return CSS class for styling specific reasons
  if (isDirect) return 'direct';
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

