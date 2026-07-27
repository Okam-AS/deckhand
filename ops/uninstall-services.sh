#!/usr/bin/env bash
# Stop and remove the deckhand LaunchAgents. Leaves logs in ~/.deckhand/logs.
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
for label in no.deckhand.server no.deckhand.tunnel; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$AGENTS/$label.plist"
  echo "removed $label"
done
