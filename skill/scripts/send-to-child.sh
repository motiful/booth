#!/bin/bash
# send-to-child.sh — Send a message to a child Claude Code session via tmux
#
# Usage: send-to-child.sh <socket-path> <session-name> <message>
#   or:  send-to-child.sh <session-name> <message>  (uses BOOTH_SOCKET env)

set -euo pipefail

if [[ $# -ge 3 ]]; then
  # Called with socket path (from context menu)
  SOCK="$1"; NAME="$2"; MESSAGE="$3"
  T="tmux -S $SOCK"
elif [[ $# -eq 2 ]]; then
  # Legacy: called with session name + message (uses BOOTH_SOCKET env)
  SOCKET="${BOOTH_SOCKET:-booth}"
  NAME="$1"; MESSAGE="$2"
  T="tmux -L $SOCKET"
else
  echo "Error: usage: send-to-child.sh [socket-path] <session-name> <message>" >&2
  exit 1
fi

# Check session exists
if ! $T has-session -t "$NAME" 2>/dev/null; then
  echo "Error: session '$NAME' does not exist" >&2
  exit 1
fi

# Send message as literal keystrokes, then press Enter
$T send-keys -t "$NAME" -l "$MESSAGE"
sleep 0.3
$T send-keys -t "$NAME" Enter

echo "Sent to $NAME"
