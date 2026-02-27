#!/bin/bash
# send-to-child.sh — Send a message to a child Claude Code session via tmux
#
# Usage: send-to-child.sh [--pane %N] <session-name> <message>
#   or:  send-to-child.sh <socket-path> <session-name> <message>
#
# Uses unified sendMessage() from input-box-check.mjs for safe injection
# with input stash/restore and edge case handling.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANE_ID=""

# Parse optional --pane flag
if [[ "${1:-}" == "--pane" ]]; then
  PANE_ID="$2"; shift 2
fi

if [[ $# -ge 3 ]]; then
  # Called with socket path (from context menu)
  SOCK_ARG="$1"; NAME="$2"; MESSAGE="$3"
  # Extract socket name from path for -L usage
  SOCKET="$(basename "$SOCK_ARG")"
elif [[ $# -eq 2 ]]; then
  # Legacy: called with session name + message (uses BOOTH_SOCKET env)
  SOCKET="${BOOTH_SOCKET:-booth}"
  NAME="$1"; MESSAGE="$2"
else
  echo "Error: usage: send-to-child.sh [--pane %N] [socket-path] <session-name> <message>" >&2
  exit 1
fi

# Resolve pane ID: prefer --pane arg, then look up from decks.json, then fall back to session name
TARGET="$NAME"
if [[ -n "$PANE_ID" ]]; then
  TARGET="$PANE_ID"
else
  # Try to resolve pane ID from decks.json
  RESOLVED=$(node -e "
    const fs = require('fs');
    const path = require('path');
    // Walk up from cwd looking for .booth/decks.json
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, '.booth', 'decks.json');
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const deck = (data.decks || []).find(d => d.name === process.argv[1]);
        if (deck && deck.paneId) { process.stdout.write(deck.paneId); process.exit(0); }
        if (deck) process.exit(0); // found deck but no paneId
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  " "$NAME" 2>/dev/null || true)
  if [[ -n "$RESOLVED" ]]; then
    TARGET="$RESOLVED"
  fi
fi

# Use unified sendMessage for safe injection with stash/restore
node "$SCRIPT_DIR/input-box-check.mjs" send --socket "$SOCKET" --pane "$TARGET" --message "$MESSAGE"
