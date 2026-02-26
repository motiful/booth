#!/bin/bash
# booth-heartbeat.sh — External heartbeat for Booth (cron/launchd)
#
# Discovers all running Booth instances and sends heartbeat to each.
# Scans /tmp/tmux-<uid>/booth-* for per-project sockets.
#
# Install via crontab (every 3 minutes):
#   */3 * * * * ~/.claude/skills/booth-skill/scripts/booth-heartbeat.sh >> /tmp/booth-heartbeat.log 2>&1

set -euo pipefail

SESSION="dj"
LEGACY_SESSION="booth-main"
LOG_PREFIX="[booth-heartbeat $(date '+%Y-%m-%d %H:%M:%S')]"
TMUX_DIR="/tmp/tmux-$(id -u)"
FOUND=0

# Scan for all booth-* sockets
if [[ -d "$TMUX_DIR" ]]; then
  for sock_path in "$TMUX_DIR"/booth-*; do
    [[ -e "$sock_path" ]] || continue
    SOCK_NAME="$(basename "$sock_path")"

    # Check if this socket has a DJ session
    if tmux -L "$SOCK_NAME" has-session -t "$SESSION" 2>/dev/null; then
      tmux -L "$SOCK_NAME" send-keys -t "$SESSION" -l "heartbeat"
      sleep 0.3
      tmux -L "$SOCK_NAME" send-keys -t "$SESSION" Enter
      echo "$LOG_PREFIX Heartbeat sent to $SESSION on socket $SOCK_NAME"
      FOUND=$((FOUND + 1))
    fi
  done
fi

# Legacy: check the old "booth" socket with "booth-main" session
if tmux -L "booth" has-session -t "$LEGACY_SESSION" 2>/dev/null; then
  tmux -L "booth" send-keys -t "$LEGACY_SESSION" -l "heartbeat"
  sleep 0.3
  tmux -L "booth" send-keys -t "$LEGACY_SESSION" Enter
  echo "$LOG_PREFIX Heartbeat sent to $LEGACY_SESSION on legacy socket booth"
  FOUND=$((FOUND + 1))
fi

if [[ $FOUND -eq 0 ]]; then
  echo "$LOG_PREFIX No running Booth instances found."
fi
