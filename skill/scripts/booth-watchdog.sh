#!/bin/bash
# booth-watchdog.sh — Persistent process monitor for Booth decks
#
# Replaces cron as primary monitoring. Runs in a hidden tmux window
# inside the DJ session ("_watchdog" window).
#
# Main loop:
#   1. Read .booth/decks.json for active decks
#   2. No active decks → exit
#   3. For each deck: capture-pane + detect-state.sh
#      - working → skip (zero tokens)
#      - anything else → send-keys alert to DJ
#   4. Adaptive sleep: 5s initial, +5s per quiet cycle (max 120s), reset on change
#   5. All decks done (none active in decks.json) → auto-exit
#
# Started by spawn-child.sh; guarded by booth-heartbeat.sh (cron).

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DETECT_STATE="$SCRIPT_DIR/detect-state.sh"
SOCKET="${BOOTH_SOCKET:-booth}"
DJ_SESSION="${BOOTH_DJ:-dj}"

# Adaptive sleep parameters
INTERVAL=5
MIN_INTERVAL=5
STEP=5
MAX_INTERVAL=120

log() {
  echo "[watchdog $(date '+%H:%M:%S')] $*"
}

# Return names of decks that should be monitored (active states only)
get_active_decks() {
  local decks_json=".booth/decks.json"
  [[ -f "$decks_json" ]] || return
  jq -r '
    .decks[]
    | select(.status != "completed" and .status != "crashed" and .status != "detached")
    | .name
  ' "$decks_json" 2>/dev/null || true
}

# --- Preflight ---

if [[ ! -x "$DETECT_STATE" ]]; then
  log "ERROR: detect-state.sh not found at $DETECT_STATE"
  exit 1
fi

if ! tmux -L "$SOCKET" has-session -t "$DJ_SESSION" 2>/dev/null; then
  log "No DJ session on socket $SOCKET. Exiting."
  exit 0
fi

log "Started. socket=$SOCKET dj=$DJ_SESSION cwd=$(pwd)"

# --- Main loop ---

PREV_SNAPSHOT=""

while true; do
  # DJ gone → exit
  if ! tmux -L "$SOCKET" has-session -t "$DJ_SESSION" 2>/dev/null; then
    log "DJ session gone. Exiting."
    exit 0
  fi

  # No active decks → exit
  ACTIVE=$(get_active_decks)
  if [[ -z "$ACTIVE" ]]; then
    log "No active decks. Exiting."
    exit 0
  fi

  # Scan each deck
  SNAPSHOT=""
  ALERTS=""

  while IFS= read -r deck; do
    [[ -z "$deck" ]] && continue

    # Session gone from tmux — record but don't alert (DJ handles via reconciliation)
    if ! tmux -L "$SOCKET" has-session -t "$deck" 2>/dev/null; then
      SNAPSHOT+="$deck=gone;"
      continue
    fi

    PANE=$(tmux -L "$SOCKET" capture-pane -t "$deck" -p -S -30 2>/dev/null || echo "")
    STATE=$(echo "$PANE" | bash "$DETECT_STATE" 2>/dev/null || echo "unknown")
    SNAPSHOT+="$deck=$STATE;"

    case "$STATE" in
      working)
        # Normal operation — silent
        ;;
      *)
        # Non-working state — include in alert
        ALERTS+="[booth-alert] deck $deck $STATE. "
        ;;
    esac
  done <<< "$ACTIVE"

  # Only alert DJ when state snapshot changes (dedup)
  if [[ "$SNAPSHOT" != "$PREV_SNAPSHOT" ]]; then
    if [[ -n "$ALERTS" ]]; then
      tmux -L "$SOCKET" send-keys -t "$DJ_SESSION" -l "$ALERTS"
      sleep 0.3
      tmux -L "$SOCKET" send-keys -t "$DJ_SESSION" Enter
      log "Alert → $ALERTS"
    fi
    # State changed — reset interval
    INTERVAL=$MIN_INTERVAL
  else
    # No change — back off
    INTERVAL=$(( INTERVAL + STEP ))
    if [[ $INTERVAL -gt $MAX_INTERVAL ]]; then
      INTERVAL=$MAX_INTERVAL
    fi
  fi

  PREV_SNAPSHOT="$SNAPSHOT"
  log "sleep ${INTERVAL}s | $SNAPSHOT"
  sleep "$INTERVAL"
done
