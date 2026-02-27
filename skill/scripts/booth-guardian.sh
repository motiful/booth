#!/bin/bash
# booth-guardian.sh — Watchdog guardian (cron safety net)
#
# Runs via cron every 10 minutes. Its ONLY job is to ensure the watchdog
# process is alive for each booth socket that has active decks. If the
# watchdog died (OOM, crash, signal), this restarts it.
#
# The watchdog itself handles all deck state detection and alert writing.
# This script does NOT do any deck monitoring — that's the watchdog's job.
#
# Install via crontab:
#   */10 * * * * ~/.claude/skills/booth-skill/scripts/booth-guardian.sh >> /tmp/booth-guardian.log 2>&1

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL_STATE="$SCRIPT_DIR/jsonl-state.mjs"
DJ_SESSION="dj"
LOG_PREFIX="[booth-guardian $(date '+%Y-%m-%d %H:%M:%S')]"
TMUX_DIR="/tmp/tmux-$(id -u)"

if [[ ! -d "$TMUX_DIR" ]]; then
  echo "$LOG_PREFIX No tmux socket dir."
  exit 0
fi

if [[ ! -f "$JSONL_STATE" ]]; then
  echo "$LOG_PREFIX ERROR: jsonl-state.mjs not found at $JSONL_STATE"
  exit 1
fi

for sock_path in "$TMUX_DIR"/booth-*; do
  [[ -e "$sock_path" ]] || continue
  SOCK_NAME="$(basename "$sock_path")"

  # Must have a DJ session
  if ! tmux -L "$SOCK_NAME" has-session -t "$DJ_SESSION" 2>/dev/null; then
    continue
  fi

  # Check if there are any decks (non-DJ sessions)
  DECK_COUNT=0
  while IFS= read -r name; do
    [[ "$name" == "$DJ_SESSION" || -z "$name" ]] && continue
    DECK_COUNT=$((DECK_COUNT + 1))
  done < <(tmux -L "$SOCK_NAME" list-sessions -F "#{session_name}" 2>/dev/null)

  if [[ $DECK_COUNT -eq 0 ]]; then
    echo "$LOG_PREFIX $SOCK_NAME: no decks, skipping."
    continue
  fi

  # Get DJ's working directory to find .booth/
  DJ_CWD=$(tmux -L "$SOCK_NAME" display-message -t "$DJ_SESSION" -p "#{pane_current_path}" 2>/dev/null || true)
  if [[ -z "$DJ_CWD" || ! -d "$DJ_CWD/.booth" ]]; then
    echo "$LOG_PREFIX $SOCK_NAME: no .booth/ dir found, skipping."
    continue
  fi

  # Check if watchdog process is alive via PID file
  PID_FILE="$DJ_CWD/.booth/watchdog.pid"
  WATCHDOG_ALIVE=false
  if [[ -f "$PID_FILE" ]]; then
    WD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$WD_PID" ]] && kill -0 "$WD_PID" 2>/dev/null; then
      WATCHDOG_ALIVE=true
    fi
  fi

  if [[ "$WATCHDOG_ALIVE" == true ]]; then
    echo "$LOG_PREFIX $SOCK_NAME: watchdog alive (pid=$WD_PID), $DECK_COUNT deck(s). OK."
  else
    echo "$LOG_PREFIX $SOCK_NAME: watchdog DEAD with $DECK_COUNT deck(s). Restarting..."

    # Start watchdog as background process
    cd "$DJ_CWD"
    BOOTH_SOCKET="$SOCK_NAME" BOOTH_DJ="$DJ_SESSION" \
      nohup node "$JSONL_STATE" watchdog \
      >> /tmp/booth-watchdog-${SOCK_NAME}.log 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > "$PID_FILE"
    echo "$LOG_PREFIX $SOCK_NAME: watchdog restarted (pid=$NEW_PID)."

    # Write alert to .booth/alerts.json (Layer 2)
    ALERTS_FILE="$DJ_CWD/.booth/alerts.json"
    ALERT_MSG="watchdog was down — restarted by cron. $DECK_COUNT deck(s) being monitored."
    node "$JSONL_STATE" write-alert "$ALERTS_FILE" "_watchdog" "error" "$ALERT_MSG" 2>/dev/null || true
    echo "$LOG_PREFIX Alert written to $ALERTS_FILE"

    # Layer 4: urgent display-message (watchdog restart is critical)
    tmux -L "$SOCK_NAME" display-message -d 5000 "⚠ Booth: watchdog restarted by cron" 2>/dev/null || true
  fi
done
