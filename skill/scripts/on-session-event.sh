#!/usr/bin/env bash
# on-session-event.sh — tmux hook handler for Booth session lifecycle
#
# Called by tmux set-hook for session-created / session-closed.
# Manages .booth/decks.json and watchdog lifecycle automatically.
#
# Usage (from tmux hook):
#   bash on-session-event.sh created <session-name> <socket-path>
#   bash on-session-event.sh closed  <session-name> <socket-path>
#
# Idempotent: safe to call multiple times for the same event.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

EVENT="${1:-}"
SESSION_NAME="${2:-}"
SOCK_PATH="${3:-}"

[[ -z "$EVENT" || -z "$SESSION_NAME" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL_STATE="$SCRIPT_DIR/jsonl-state.mjs"

# Derive socket name for tmux -L
if [[ -n "$SOCK_PATH" ]]; then
  SOCK_NAME="$(basename "$SOCK_PATH")"
else
  SOCK_NAME="${BOOTH_SOCKET:-booth}"
fi

# Find DJ session name
DJ_SESSION=$(tmux -L "$SOCK_NAME" show -gvq @booth-dj 2>/dev/null || echo "dj")

# Skip events for the DJ session itself
[[ "$SESSION_NAME" == "$DJ_SESSION" ]] && exit 0

# Skip internal sessions (prefixed with _)
[[ "$SESSION_NAME" == _* ]] && exit 0

# Find .booth/ directory via DJ's CWD
DJ_CWD=$(tmux -L "$SOCK_NAME" display-message -t "$DJ_SESSION" -p "#{pane_current_path}" 2>/dev/null || true)
[[ -z "$DJ_CWD" || ! -d "$DJ_CWD/.booth" ]] && exit 0

DECKS_FILE="$DJ_CWD/.booth/decks.json"
ALERTS_FILE="$DJ_CWD/.booth/alerts.json"
PID_FILE="$DJ_CWD/.booth/watchdog.pid"

case "$EVENT" in
  created)
    # --- Session created: add deck to decks.json ---

    # Get the new session's working directory and stable pane ID
    DECK_CWD=$(tmux -L "$SOCK_NAME" display-message -t "$SESSION_NAME" -p "#{pane_current_path}" 2>/dev/null || echo "$DJ_CWD")
    PANE_ID=$(tmux -L "$SOCK_NAME" list-panes -t "$SESSION_NAME" -F '#{pane_id}' 2>/dev/null | head -1)

    # Add to decks.json if not already present (idempotent)
    node -e "
      const fs = require('fs');
      const f = process.argv[1];
      const name = process.argv[2];
      const dir = process.argv[3];
      const paneId = process.argv[4];
      let data = { decks: [] };
      try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
      if (data.decks.some(d => d.name === name)) process.exit(0);
      data.decks.push({
        name,
        dir,
        paneId: paneId || undefined,
        status: 'working',
        created: new Date().toISOString(),
      });
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, f);
    " "$DECKS_FILE" "$SESSION_NAME" "$DECK_CWD" "$PANE_ID" 2>/dev/null || true

    # Write deck-created alert
    if [[ -f "$JSONL_STATE" ]]; then
      node "$JSONL_STATE" write-alert "$ALERTS_FILE" "$SESSION_NAME" "deck-created" \
        "deck-created name=$SESSION_NAME dir=$DECK_CWD" 2>/dev/null || true
    fi

    # Start watchdog if not running
    WATCHDOG_ALIVE=false
    if [[ -f "$PID_FILE" ]]; then
      WD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
      if [[ -n "$WD_PID" ]] && kill -0 "$WD_PID" 2>/dev/null; then
        WATCHDOG_ALIVE=true
      fi
    fi

    if [[ "$WATCHDOG_ALIVE" == false && -f "$JSONL_STATE" ]]; then
      cd "$DJ_CWD"
      BOOTH_SOCKET="$SOCK_NAME" BOOTH_DJ="$DJ_SESSION" \
        nohup node "$JSONL_STATE" watchdog \
        >> "/tmp/booth-watchdog-${SOCK_NAME}.log" 2>&1 &
      echo "$!" > "$PID_FILE"
    fi
    ;;

  closed)
    # --- Session closed: update decks.json, maybe stop watchdog ---

    # Mark deck as completed in decks.json
    node -e "
      const fs = require('fs');
      const f = process.argv[1];
      const name = process.argv[2];
      let data = { decks: [] };
      try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
      const deck = data.decks.find(d => d.name === name);
      if (!deck) process.exit(0);
      // Only auto-close if still in an active state
      if (!['completed', 'crashed', 'detached'].includes(deck.status)) {
        deck.status = 'completed';
      }
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, f);
    " "$DECKS_FILE" "$SESSION_NAME" 2>/dev/null || true

    # Write session-closed alert
    if [[ -f "$JSONL_STATE" ]]; then
      node "$JSONL_STATE" write-alert "$ALERTS_FILE" "$SESSION_NAME" "session-closed" \
        "deck $SESSION_NAME session closed." 2>/dev/null || true
    fi

    # Check if any active decks remain — if not, stop watchdog
    ACTIVE_COUNT=$(node -e "
      const fs = require('fs');
      try {
        const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
        const active = (d.decks || []).filter(x => !['completed','crashed','detached'].includes(x.status));
        process.stdout.write(String(active.length));
      } catch { process.stdout.write('0'); }
    " "$DECKS_FILE" 2>/dev/null || echo "0")

    if [[ "$ACTIVE_COUNT" == "0" && -f "$PID_FILE" ]]; then
      WD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
      if [[ -n "$WD_PID" ]] && kill -0 "$WD_PID" 2>/dev/null; then
        kill "$WD_PID" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
    fi
    ;;
esac
