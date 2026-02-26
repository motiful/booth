#!/bin/bash
# send-to-child.sh — Send a message to a child Claude Code session via tmux
#
# Usage: send-to-child.sh <session-name> <message>

set -euo pipefail

SOCKET="${BOOTH_SOCKET:-booth}"

if [[ $# -lt 2 ]]; then
  echo "Error: usage: send-to-child.sh <session-name> <message>" >&2
  exit 1
fi

NAME="$1"
MESSAGE="$2"

# Check session exists
if ! tmux -L "$SOCKET" has-session -t "$NAME" 2>/dev/null; then
  echo "Error: session '$NAME' does not exist" >&2
  exit 1
fi

# Send message as literal keystrokes, then press Enter
tmux -L "$SOCKET" send-keys -t "$NAME" -l "$MESSAGE"
sleep 0.3
tmux -L "$SOCKET" send-keys -t "$NAME" Enter

echo "Sent to $NAME"
