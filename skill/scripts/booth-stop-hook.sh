#!/usr/bin/env bash
# booth-stop-hook.sh — CC stop hook that surfaces deck alerts (Layer 3)
#
# Installed as a CC stop hook. Runs after each DJ turn ends.
# Reads .booth/alerts.json, outputs unread alerts as system context,
# then clears the file. CC injects stdout into the next turn.
#
# Only activates for the DJ session (checks tmux session name).
# Safe no-op for non-Booth sessions (no .booth/ → exits silently).

set -euo pipefail

# Only run if .booth/ exists (we're in a Booth project)
ALERTS_FILE=".booth/alerts.json"
[[ -d ".booth" ]] || exit 0
[[ -f "$ALERTS_FILE" ]] || exit 0

# Only run for the DJ session
SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || true)
if [[ -z "$SESSION_NAME" ]]; then
  exit 0
fi

# Read the DJ session name from tmux user variable, fallback to "dj"
SOCK=$(tmux display-message -p '#{socket_path}' 2>/dev/null || true)
if [[ -n "$SOCK" ]]; then
  DJ_NAME=$(tmux -S "$SOCK" show -gvq @booth-dj 2>/dev/null || echo "dj")
else
  DJ_NAME="dj"
fi

if [[ "$SESSION_NAME" != "$DJ_NAME" ]]; then
  exit 0
fi

# Find jsonl-state.mjs (same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL_STATE="$SCRIPT_DIR/jsonl-state.mjs"

# Read and clear alerts via Node.js utility
if [[ -f "$JSONL_STATE" ]]; then
  node "$JSONL_STATE" read-alerts "$ALERTS_FILE" 2>/dev/null || true
else
  # Fallback: pure bash + jq (if jsonl-state.mjs not found)
  if command -v jq &>/dev/null; then
    COUNT=$(jq 'length' "$ALERTS_FILE" 2>/dev/null || echo "0")
    if [[ "$COUNT" -gt 0 ]]; then
      jq -r '.[] | "[booth-alert] [\(.type)] \(.deck): \(.message) (at \(.timestamp[:19]))"' "$ALERTS_FILE" 2>/dev/null
      echo '[]' > "$ALERTS_FILE"
    fi
  fi
fi
