#!/bin/bash
# booth-heartbeat.sh — Watchdog guardian (cron safety net)
#
# Runs via cron every 10 minutes. Its ONLY job is to ensure the watchdog
# process is alive for each booth socket that has active decks. If the
# watchdog died (OOM, crash, tmux window closed), this restarts it.
#
# The watchdog itself handles all deck state detection and DJ alerting.
# This script does NOT do any deck monitoring — that's the watchdog's job.
#
# Install via crontab:
#   */10 * * * * ~/.claude/skills/booth-skill/scripts/booth-heartbeat.sh >> /tmp/booth-heartbeat.log 2>&1

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG_SCRIPT="$SCRIPT_DIR/booth-watchdog.sh"
DJ_SESSION="dj"
LOG_PREFIX="[booth-heartbeat $(date '+%Y-%m-%d %H:%M:%S')]"
TMUX_DIR="/tmp/tmux-$(id -u)"

if [[ ! -d "$TMUX_DIR" ]]; then
  echo "$LOG_PREFIX No tmux socket dir."
  exit 0
fi

if [[ ! -x "$WATCHDOG_SCRIPT" ]]; then
  echo "$LOG_PREFIX ERROR: booth-watchdog.sh not found at $WATCHDOG_SCRIPT"
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

  # Check if watchdog window exists in DJ session
  WATCHDOG_WINDOW="_watchdog"
  WATCHDOG_ALIVE=false
  if tmux -L "$SOCK_NAME" list-windows -t "$DJ_SESSION" -F "#{window_name}" 2>/dev/null | grep -q "^${WATCHDOG_WINDOW}$"; then
    WATCHDOG_ALIVE=true
  fi

  if [[ "$WATCHDOG_ALIVE" == true ]]; then
    echo "$LOG_PREFIX $SOCK_NAME: watchdog alive, $DECK_COUNT deck(s). OK."
  else
    echo "$LOG_PREFIX $SOCK_NAME: watchdog DEAD with $DECK_COUNT deck(s). Restarting..."
    DJ_CWD=$(tmux -L "$SOCK_NAME" display-message -t "$DJ_SESSION" -p "#{pane_current_path}" 2>/dev/null || true)
    if [[ -n "$DJ_CWD" ]]; then
      tmux -L "$SOCK_NAME" new-window -d -t "$DJ_SESSION" -n "$WATCHDOG_WINDOW" -c "$DJ_CWD" \
        "BOOTH_SOCKET=$SOCK_NAME BOOTH_DJ=$DJ_SESSION $WATCHDOG_SCRIPT"
      echo "$LOG_PREFIX $SOCK_NAME: watchdog restarted."

      # Write alert to .booth/alerts.json (Layer 2)
      ALERTS_FILE="$DJ_CWD/.booth/alerts.json"
      if [[ -d "$DJ_CWD/.booth" ]]; then
        ALERT_MSG="watchdog was down — restarted by cron. $DECK_COUNT deck(s) being monitored."
        ALERT_JSON=$(python3 -c "
import json, sys, os
from datetime import datetime, timezone
f = sys.argv[1]
alerts = []
try:
    with open(f) as fh: alerts = json.load(fh)
except: pass
alerts.append({'timestamp': datetime.now(timezone.utc).isoformat(), 'deck': '_watchdog', 'type': 'error', 'message': sys.argv[2]})
tmp = f + '.tmp'
with open(tmp, 'w') as fh: json.dump(alerts, fh, indent=2); fh.write('\n')
os.replace(tmp, f)
" "$ALERTS_FILE" "$ALERT_MSG" 2>&1)
        echo "$LOG_PREFIX Alert written to $ALERTS_FILE"
      fi

      # Layer 4: urgent display-message (watchdog restart is critical)
      tmux -L "$SOCK_NAME" display-message -d 5000 "⚠ Booth: watchdog restarted by cron"
    else
      echo "$LOG_PREFIX $SOCK_NAME: could not determine DJ CWD, skipping restart."
    fi
  fi
done
