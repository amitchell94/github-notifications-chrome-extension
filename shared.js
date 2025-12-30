const API_BASE = 'https://api.github.com';
const HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
};

// Configuration constants
const MAX_NOTIFICATIONS = 100;
const API_BATCH_SIZE = 5;
const MAX_COMMENTS_PER_FETCH = 50;

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
  
  // Check for X-Poll-Interval header (GitHub's recommended polling interval in seconds)
  const pollInterval = response.headers.get('X-Poll-Interval');
  if (pollInterval) {
    const intervalSeconds = parseInt(pollInterval, 10);
    if (!isNaN(intervalSeconds) && intervalSeconds > 0) {
      // Store the poll interval (convert seconds to minutes, minimum 1 minute)
      const intervalMinutes = Math.max(1, Math.ceil(intervalSeconds / 60));
      await chrome.storage.local.set({ pollIntervalMinutes: intervalMinutes });
    }
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

// Helper functions for notification processing
function needsActivityCheck(notification) {
  return (notification.reason === 'author' || notification.reason === 'comment' || notification.reason === 'subscribed') && 
         notification.type === 'PullRequest';
}

async function fetchNewIssueComments(repoUrl, prNumber, sinceDate, currentUser, token) {
  try {
    const commentsUrl = `${repoUrl}/issues/${prNumber}/comments?per_page=${MAX_COMMENTS_PER_FETCH}`;
    const comments = await fetchWithAuth(commentsUrl, token);
    const newComments = sinceDate 
      ? comments.filter(c => new Date(c.created_at) > sinceDate && c.user?.login !== currentUser)
      : comments.filter(c => c.user?.login !== currentUser).slice(-5);
    
    return newComments.map(comment => ({
      type: 'comment',
      author: comment.user?.login,
      createdAt: new Date(comment.created_at)
    }));
  } catch (err) {
    return [];
  }
}

async function fetchNewReviewComments(repoUrl, prNumber, sinceDate, currentUser, token) {
  try {
    const reviewCommentsUrl = `${repoUrl}/pulls/${prNumber}/comments?per_page=${MAX_COMMENTS_PER_FETCH}`;
    const reviewComments = await fetchWithAuth(reviewCommentsUrl, token);
    const newReviewComments = sinceDate
      ? reviewComments.filter(c => new Date(c.created_at) > sinceDate && c.user?.login !== currentUser)
      : reviewComments.filter(c => c.user?.login !== currentUser).slice(-5);
    
    return newReviewComments.map(comment => ({
      type: 'review_comment',
      author: comment.user?.login,
      createdAt: new Date(comment.created_at)
    }));
  } catch (err) {
    return [];
  }
}

async function fetchNewReviews(repoUrl, prNumber, sinceDate, currentUser, token) {
  try {
    const reviewsUrl = `${repoUrl}/pulls/${prNumber}/reviews?per_page=${MAX_COMMENTS_PER_FETCH}`;
    const reviews = await fetchWithAuth(reviewsUrl, token);
    
    const newReviews = sinceDate
      ? reviews.filter(r => new Date(r.submitted_at) > sinceDate && r.user?.login !== currentUser)
      : reviews.filter(r => r.user?.login !== currentUser).slice(-5);
    
    return newReviews.map(review => {
      const state = review.state?.toLowerCase();
      let reviewType = 'reviewed';
      if (state === 'approved') reviewType = 'approved';
      else if (state === 'changes_requested') reviewType = 'changes_requested';
      else if (state === 'commented') reviewType = 'reviewed';
      
      return {
        type: reviewType,
        author: review.user?.login,
        createdAt: new Date(review.submitted_at)
      };
    });
  } catch (err) {
    return [];
  }
}

function buildActivitySummary(notification) {
  if (notification.newActivities.length === 0) {
    return;
  }
  
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

function filterNotificationByRules(notification) {
  if (notification.isTeamReview) {
    return false;
  }
  // For merged/closed PRs, only show if there's new activity
  if (notification.isClosedOrMerged && notification.newActivities.length === 0) {
    return false;
  }
  // For author/comment/subscribed notifications, only show if there's new activity
  if ((notification.reason === 'author' || notification.reason === 'comment' || notification.reason === 'subscribed') && notification.newActivities.length === 0) {
    return false;
  }
  return true;
}

async function loadNotifications(token, currentUser = null) {
  try {
    // Get current user first if not provided
    if (!currentUser) {
      const user = await fetchWithAuth(`${API_BASE}/user`, token);
      currentUser = user.login;
    }
    
    // Get notifications
    const notifications = await fetchWithAuth(
      `${API_BASE}/notifications?per_page=${MAX_NOTIFICATIONS}`,
      token
    );
    
    if (notifications.length === 0) {
      await chrome.storage.local.set({ cachedNotifications: [], cachedAt: Date.now() });
      return {
        notifications: [],
        currentUser
      };
    }
    
    // Only show notifications we care about:
    // - review_requested (direct only, filtered later)
    // - author (activity on your PRs/issues)
    // - mention (someone @mentioned you)
    // - comment (replies to threads you commented on)
    const allowedReasons = ['review_requested', 'author', 'mention', 'comment', 'subscribed'];
    
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
        isTeamReview: false
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt); // Most recent first
    
    // Now fetch details
    const detailedNotifications = [...quickNotifications];
    
    // Process in batches for speed
    for (let i = 0; i < detailedNotifications.length; i += API_BATCH_SIZE) {
      const batch = detailedNotifications.slice(i, i + API_BATCH_SIZE);
      
      await Promise.all(batch.map(async (notification) => {
        if (!notification.url) return;
        
        try {
          const details = await fetchWithAuth(notification.url, token);
          notification.author = details.user?.login;
          
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
          if (needsActivityCheck(notification)) {
            // Track if PR is merged/closed - we'll filter later based on activity
            if (details.merged || details.state === 'closed') {
              notification.isClosedOrMerged = true;
            }
            
            const prNumber = notification.url.match(/\/pulls\/(\d+)$/)?.[1];
            const repoUrl = notification.url.replace(/\/pulls\/\d+$/, '');
            const sinceDate = notification.lastReadAt;
            
            if (prNumber) {
              // Fetch all activity types in parallel
              const [comments, reviewComments, reviews] = await Promise.all([
                fetchNewIssueComments(repoUrl, prNumber, sinceDate, currentUser, token),
                fetchNewReviewComments(repoUrl, prNumber, sinceDate, currentUser, token),
                fetchNewReviews(repoUrl, prNumber, sinceDate, currentUser, token)
              ]);
              
              notification.newActivities = [...comments, ...reviewComments, ...reviews];
              
              // Sort activities by date (newest first)
              notification.newActivities.sort((a, b) => b.createdAt - a.createdAt);
              
              // Build summary
              buildActivitySummary(notification);
            }
          }
        } catch (err) {
          // Silently continue on error - notification will show without details
        }
      }));
    }
    
    // Final filtered list
    const finalFiltered = detailedNotifications
      .filter(filterNotificationByRules)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    
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
    
    return {
      notifications: finalFiltered,
      currentUser
    };
    
  } catch (err) {
    console.error('Failed to load notifications:', err);
    throw err;
  }
}
