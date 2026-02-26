#!/bin/bash
# booth-heartbeat.sh — External heartbeat for Booth (cron/launchd)
#
# Smart heartbeat: only sends if there are active decks (non-DJ sessions).
# No decks = no heartbeat = no wasted tokens.
#
# Install via crontab (every 10 minutes):
#   */10 * * * * ~/.claude/skills/booth-skill/scripts/booth-heartbeat.sh >> /tmp/booth-heartbeat.log 2>&1

set -euo pipefail

# Ensure Homebrew tmux is in PATH (cron has minimal PATH)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SESSION="dj"
LOG_PREFIX="[booth-heartbeat $(date '+%Y-%m-%d %H:%M:%S')]"
TMUX_DIR="/tmp/tmux-$(id -u)"
FOUND=0

# Scan for all booth-* sockets
if [[ -d "$TMUX_DIR" ]]; then
  for sock_path in "$TMUX_DIR"/booth-*; do
    [[ -e "$sock_path" ]] || continue
    SOCK_NAME="$(basename "$sock_path")"

    # Check if this socket has a DJ session
    if ! tmux -L "$SOCK_NAME" has-session -t "$SESSION" 2>/dev/null; then
      continue
    fi

    # Count non-DJ sessions (decks)
    DECK_COUNT=$(tmux -L "$SOCK_NAME" list-sessions -F "#{session_name}" 2>/dev/null \
      | grep -cv "^${SESSION}$" || true)

    if [[ "$DECK_COUNT" -eq 0 ]]; then
      # No decks — skip heartbeat, don't waste tokens
      echo "$LOG_PREFIX No decks on $SOCK_NAME, skipping."
      continue
    fi

    # Decks exist — send heartbeat
    tmux -L "$SOCK_NAME" send-keys -t "$SESSION" -l "heartbeat"
    sleep 0.3
    tmux -L "$SOCK_NAME" send-keys -t "$SESSION" Enter
    echo "$LOG_PREFIX Heartbeat sent ($DECK_COUNT decks) on $SOCK_NAME"
    FOUND=$((FOUND + 1))
  done
fi

if [[ $FOUND -eq 0 ]]; then
  echo "$LOG_PREFIX No active Booth instances with decks."
fi
