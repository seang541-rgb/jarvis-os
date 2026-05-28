# Jarvis Skills

This folder is the extension point for Jarvis capabilities.

Current first-party skills:

- `files`: allowed local file listing, search, and text reading.
- `screen`: primary display screenshot capture.
- `reminders`: local reminder scheduling and notifications.
- `safety`: confirmation rules for sensitive actions.

The current server still registers tools in `server.js`. New tools should be added here first, then wired into the tool registry once the skill loader is extracted.
