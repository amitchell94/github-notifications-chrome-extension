# GitHub Notifications Chrome Extension

A lightweight Chrome extension for viewing and managing your GitHub notifications at a glance, with smart filtering and macOS system notifications.

## Features

### Real-time Notifications
Automatic background checks every 2 minutes (or as recommended by GitHub)

### Smart Filtering 
Only shows notifications you care about:
  - Direct review requests (team reviews can be auto-archived or shown based on settings)
  - Activity on your PRs and issues
  - @mentions
  - Comments on threads you've participated in
  - New activity on PRs you're watching

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/amitchell94/github-notifications-chrome-extension.git
   cd github-notifications-chrome-extension
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in top right)

4. Click **Load unpacked** and select the extension directory

5. The extension icon should appear in your Chrome toolbar

## Setup

1. **Create a GitHub Personal Access Token**:
   - Go to [GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens)
   - Click **Generate new token (classic)**
   - Give it a descriptive name (e.g., "Chrome Notifications Extension")
   - Select these scopes:
     - `notifications` - Access notifications
     - `repo` - Access repository data (needed for PR/issue details)
   - Click **Generate token** and copy it

2. **Configure the Extension**:
   - Click the extension icon in your Chrome toolbar
   - Click **Settings** at the bottom
   - Paste your GitHub token
   - Click **Save Token**

3. **Enable macOS Notifications** (optional but recommended):
   - Open **System Settings** → **Notifications**
   - Find **Google Chrome** in the list
   - Enable **Allow notifications**
   - Set banner style to **Temporary** or **Persistent**

## Settings

### Auto-mark Team Review Requests

By default, the extension automatically marks team review requests as "done" to reduce noise. Team review requests are PR review requests assigned to a team you're on, rather than directly to you.

**To change this behavior:**
1. Click the extension icon
2. Click **Settings** at the bottom
3. Toggle **Auto-mark team review requests as done**
   - **Enabled** (default): Team reviews are automatically archived and won't appear in your notification list
   - **Disabled**: Team reviews will appear in your notification list and can be manually marked as done
4. Click **Save Token** to save your preference

## Usage

### Viewing Notifications

- Click the extension icon to see your notifications
- Each notification shows:
  - Type (PR, Issue, etc.)
  - Title and repository
  - Who triggered the notification
  - What action they took (commented, approved, etc.)

### Managing Notifications

- **Mark as Read** - Click the checkmark icon (✓) to mark a notification as read
- **Mark as Done** - Click the "Done" button to archive a notification
- **Open on GitHub** - Click anywhere on the notification to open it in a new tab
- **Refresh** - Click the refresh icon in the header to manually fetch new notifications

### Notification Types

The extension shows these types of notifications:

- **Review Requested** - Someone requested your review on a PR (direct requests only, not team reviews)
- **Author** - Activity on PRs or issues you created
- **Mentioned** - Someone @mentioned you
- **Comment** - Someone replied to a thread you commented on
- **Watching** - New activity on PRs you're subscribed to (only shows if there's new activity)

## How It Works

### Smart Filtering

The extension automatically filters out noise:

- **Team review requests** can be auto-archived (configurable in settings)
- **Closed/merged PRs** are hidden unless there's new activity
- **Subscribed notifications** only appear when there are new comments or reviews
- **Author notifications** only show when there's actual activity (comments, reviews, approvals)

### Background Checks

The extension checks for new notifications every 2 minutes by default, or uses GitHub's recommended polling interval if provided. When new notifications arrive:

- The badge count updates automatically
- macOS system notifications appear (up to 3 at a time to avoid spam)
- Notifications are cached for quick viewing

## Development

### Project Structure

```
github-notifications-extension/
├── manifest.json          # Extension configuration
├── popup.html            # Popup UI structure
├── popup.css             # Popup styling
├── popup.js              # Popup logic and UI interactions
├── background.js         # Background service worker
├── shared.js             # Shared notification loading logic
└── icon48.png           # Extension icon
```

### Key Files

- **`shared.js`** - Core notification fetching and filtering logic
- **`background.js`** - Background checks, system notifications, and badge updates
- **`popup.js`** - UI rendering and user interactions

## License

MIT License - feel free to use and modify as needed.
