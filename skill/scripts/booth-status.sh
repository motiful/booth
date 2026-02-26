#!/usr/bin/env bash
# booth-status.sh — Dynamic status bar content for tmux
# Called by tmux's #() in status-right, refreshes at status-interval
#
# Usage: booth-status.sh <socket-path>
# socket-path: full path like /private/tmp/tmux-501/booth

SOCK="${1:-}"
if [[ -z "$SOCK" ]]; then
  echo "no socket"
  exit 0
fi

T="tmux -S $SOCK"
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
CURRENT=$($T display-message -p '#{client_session}' 2>/dev/null || echo "")

# List all sessions except DJ
DECKS=""
while IFS= read -r name; do
  [[ "$name" == "$DJ" ]] && continue
  [[ -z "$name" ]] && continue
  if [[ "$name" == "$CURRENT" ]]; then
    DECKS+=" ●${name}"
  else
    DECKS+=" ▸${name}"
  fi
done < <($T list-sessions -F "#{session_name}" 2>/dev/null)

if [[ -z "$DECKS" ]]; then
  echo "no decks  d=DJ"
else
  echo "${DECKS}  d=DJ"
fi
