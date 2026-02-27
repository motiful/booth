#!/bin/bash
# booth-reload.sh — Hot-reload Booth control layer
# Restarts watchdog with latest code, reloads tmux config.
# Deck sessions and CC processes are NOT affected.
#
# Usage: booth-reload.sh <socket-path>

set -euo pipefail

SOCK="${1:-}"
[[ -z "$SOCK" ]] && { echo "Usage: booth-reload.sh <socket-path>" >&2; exit 1; }

T="tmux -S $SOCK"
SCRIPTS="$(cd "$(dirname "$0")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPTS/.." && pwd -P)"

# Redirect all stdout/stderr to log file so tmux run-shell won't display
# output in "view mode" (which hijacks the current pane).
# The display-message at the end talks to tmux server directly, unaffected.
SOCK_BASE=$(basename "$SOCK" 2>/dev/null || echo "booth")
RELOAD_LOG="/tmp/booth-reload-${SOCK_BASE}.log"
exec >>"$RELOAD_LOG" 2>&1
echo "--- reload $(date '+%Y-%m-%d %H:%M:%S') ---"

DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")

# 1. Reload tmux config
TMUX_CONF="$SKILL_DIR/booth.tmux.conf"
if [[ -f "$TMUX_CONF" ]]; then
  $T source-file "$TMUX_CONF"
  echo "[reload] tmux config reloaded"
fi

# 2. Find .booth/ directory via @booth-root
BOOTH_ROOT=$($T show -gvq @booth-root 2>/dev/null || true)
if [[ -z "$BOOTH_ROOT" || ! -d "$BOOTH_ROOT/.booth" ]]; then
  echo "[reload] No .booth/ found, tmux config reloaded only."
  exit 0
fi

# 3. Stop watchdog if running
PID_FILE="$BOOTH_ROOT/.booth/watchdog.pid"
if [[ -f "$PID_FILE" ]]; then
  WD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "$WD_PID" ]] && kill -0 "$WD_PID" 2>/dev/null; then
    kill "$WD_PID" 2>/dev/null || true
    # Wait up to 5s for graceful exit
    for i in $(seq 1 10); do
      kill -0 "$WD_PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    kill -0 "$WD_PID" 2>/dev/null && kill -9 "$WD_PID" 2>/dev/null || true
    echo "[reload] watchdog stopped (was pid=$WD_PID)"
  fi
  rm -f "$PID_FILE"
fi

# 4. Check if there are active decks — if so, restart watchdog
SOCK_NAME=$(basename "$SOCK" 2>/dev/null || basename "$(echo "$SOCK" | sed 's|.*/||')")
DECK_COUNT=0
while IFS= read -r name; do
  [[ "$name" == "$DJ" || -z "$name" ]] && continue
  DECK_COUNT=$((DECK_COUNT + 1))
done < <($T list-sessions -F "#{session_name}" 2>/dev/null)

if [[ $DECK_COUNT -gt 0 ]]; then
  JSONL_STATE="$SCRIPTS/jsonl-state.mjs"
  cd "$BOOTH_ROOT"
  BOOTH_SOCKET="$SOCK_NAME" BOOTH_DJ="$DJ" \
    nohup bash "$SCRIPTS/booth-watchdog.sh" \
    >> "/tmp/booth-watchdog-${SOCK_NAME}.log" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  echo "[reload] watchdog restarted (pid=$NEW_PID), $DECK_COUNT deck(s)"
else
  echo "[reload] no active decks, watchdog not started"
fi

# 5. Notify via display-message
$T display-message -d 3000 "✓ Booth reloaded" 2>/dev/null || true
