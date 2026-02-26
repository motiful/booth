#!/bin/bash
# booth-heartbeat.sh — Smart external heartbeat for Booth (cron)
#
# ARCHITECTURE: bash does detection, DJ only hears about problems.
#
# For each booth socket with active decks:
#   1. capture-pane each deck
#   2. pipe through detect-state.sh (pure bash, zero tokens)
#   3. If state is working/thinking → SKIP (silent, zero tokens)
#   4. If state is idle/completed/needs-attention/waiting-approval → NOTIFY DJ
#   5. If no deck needs attention → DJ never hears about it
#
# This saves thousands of tokens vs. the old "send heartbeat, DJ polls everything" approach.
#
# Install via crontab:
#   */10 * * * * ~/.claude/skills/booth-skill/scripts/booth-heartbeat.sh >> /tmp/booth-heartbeat.log 2>&1

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DETECT_STATE="$SCRIPT_DIR/detect-state.sh"
DJ_SESSION="dj"
LOG_PREFIX="[booth-heartbeat $(date '+%Y-%m-%d %H:%M:%S')]"
TMUX_DIR="/tmp/tmux-$(id -u)"

if [[ ! -d "$TMUX_DIR" ]]; then
  echo "$LOG_PREFIX No tmux socket dir."
  exit 0
fi

if [[ ! -x "$DETECT_STATE" ]]; then
  echo "$LOG_PREFIX ERROR: detect-state.sh not found at $DETECT_STATE"
  exit 1
fi

for sock_path in "$TMUX_DIR"/booth-*; do
  [[ -e "$sock_path" ]] || continue
  SOCK_NAME="$(basename "$sock_path")"

  # Must have a DJ session
  if ! tmux -L "$SOCK_NAME" has-session -t "$DJ_SESSION" 2>/dev/null; then
    continue
  fi

  # Collect non-DJ sessions (decks)
  DECKS=()
  while IFS= read -r name; do
    [[ "$name" == "$DJ_SESSION" || -z "$name" ]] && continue
    DECKS+=("$name")
  done < <(tmux -L "$SOCK_NAME" list-sessions -F "#{session_name}" 2>/dev/null)

  if [[ ${#DECKS[@]} -eq 0 ]]; then
    echo "$LOG_PREFIX No decks on $SOCK_NAME, skipping."
    continue
  fi

  # Check each deck's state via bash (zero tokens)
  ALERTS=""
  for deck in "${DECKS[@]}"; do
    PANE_OUTPUT=$(tmux -L "$SOCK_NAME" capture-pane -t "$deck" -p -S -30 2>/dev/null || echo "")
    STATE=$(echo "$PANE_OUTPUT" | bash "$DETECT_STATE" 2>/dev/null || echo "unknown")

    case "$STATE" in
      working)
        # Normal operation — stay silent
        echo "$LOG_PREFIX   $deck: working (silent)"
        ;;
      idle)
        # Deck finished or waiting — DJ should check
        ALERTS+="[booth-alert] deck '$deck' is idle (may have completed). "
        echo "$LOG_PREFIX   $deck: idle → alerting DJ"
        ;;
      needs-attention)
        ALERTS+="[booth-alert] deck '$deck' needs attention — check for errors. "
        echo "$LOG_PREFIX   $deck: needs-attention → alerting DJ"
        ;;
      waiting-approval)
        ALERTS+="[booth-alert] deck '$deck' is waiting for approval — auto-approve or check. "
        echo "$LOG_PREFIX   $deck: waiting-approval → alerting DJ"
        ;;
      collapsed)
        # Context was compacted — might need re-orientation
        ALERTS+="[booth-alert] deck '$deck' context was compacted — verify it's still on track. "
        echo "$LOG_PREFIX   $deck: collapsed → alerting DJ"
        ;;
      unknown)
        # Can't determine — flag it
        ALERTS+="[booth-alert] deck '$deck' state unknown — please check. "
        echo "$LOG_PREFIX   $deck: unknown → alerting DJ"
        ;;
    esac
  done

  # Only send to DJ if there are alerts
  if [[ -n "$ALERTS" ]]; then
    # Send the alert message to DJ
    tmux -L "$SOCK_NAME" send-keys -t "$DJ_SESSION" -l "$ALERTS"
    sleep 0.3
    tmux -L "$SOCK_NAME" send-keys -t "$DJ_SESSION" Enter
    echo "$LOG_PREFIX Alerts sent to DJ on $SOCK_NAME"
  else
    echo "$LOG_PREFIX All ${#DECKS[@]} decks working normally on $SOCK_NAME (silent)."
  fi
done
