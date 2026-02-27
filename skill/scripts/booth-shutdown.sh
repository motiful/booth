#!/usr/bin/env bash
# booth-shutdown.sh — Graceful Booth shutdown
#
# Cleans up state files before killing the tmux server:
#   1. Mark all active decks as "completed" in decks.json
#   2. SIGTERM watchdog process (let it clean up tail children)
#   3. Clear alerts.json
#   4. Remove watchdog.pid
#   5. kill-server
#
# Usage:
#   bash booth-shutdown.sh <socket-path>
#   bash booth-shutdown.sh --socket-name <name>

set -euo pipefail

# --- Parse args ---
SOCK_PATH=""
SOCK_NAME=""

if [[ "${1:-}" == "--socket-name" ]]; then
  SOCK_NAME="${2:-}"
elif [[ -n "${1:-}" ]]; then
  SOCK_PATH="$1"
  SOCK_NAME="$(basename "$SOCK_PATH")"
fi

if [[ -z "$SOCK_NAME" ]]; then
  SOCK_NAME="${BOOTH_SOCKET:-booth}"
fi

# --- Find DJ CWD → .booth/ directory ---
DJ_SESSION=$(tmux -L "$SOCK_NAME" show -gvq @booth-dj 2>/dev/null || echo "dj")
DJ_CWD=$(tmux -L "$SOCK_NAME" display-message -t "$DJ_SESSION" -p "#{pane_current_path}" 2>/dev/null || true)

BOOTH_DIR=""
if [[ -n "$DJ_CWD" && -d "$DJ_CWD/.booth" ]]; then
  BOOTH_DIR="$DJ_CWD/.booth"
fi

# --- Cleanup state files ---
if [[ -n "$BOOTH_DIR" ]]; then
  DECKS_FILE="$BOOTH_DIR/decks.json"
  ALERTS_FILE="$BOOTH_DIR/alerts.json"
  PID_FILE="$BOOTH_DIR/watchdog.pid"

  # 1. Mark all active decks as "completed"
  if [[ -f "$DECKS_FILE" ]]; then
    node -e "
      const fs = require('fs');
      const f = process.argv[1];
      let data;
      try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { process.exit(0); }
      let changed = false;
      for (const d of (data.decks || [])) {
        if (!['completed', 'crashed', 'detached'].includes(d.status)) {
          d.status = 'completed';
          changed = true;
        }
      }
      if (changed) {
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, f);
      }
    " "$DECKS_FILE" 2>/dev/null || true
  fi

  # 2. SIGTERM watchdog (let it clean up tail children)
  if [[ -f "$PID_FILE" ]]; then
    WD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$WD_PID" ]] && kill -0 "$WD_PID" 2>/dev/null; then
      kill "$WD_PID" 2>/dev/null || true
      # Give it a moment to clean up tail subprocesses
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi

  # 3. Clear alerts.json
  if [[ -f "$ALERTS_FILE" ]]; then
    echo '[]' > "$ALERTS_FILE"
  fi
fi

# --- Kill tmux server ---
tmux -L "$SOCK_NAME" kill-server 2>/dev/null || true
