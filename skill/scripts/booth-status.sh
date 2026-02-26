#!/usr/bin/env bash
# booth-status.sh — Dynamic status bar content for tmux
# Called by tmux's #() in status-right, refreshes at status-interval
#
# Usage: booth-status.sh <socket-path>
# Design: ≤3 decks show names, >3 collapse to count

SOCK="${1:-}"
[[ -z "$SOCK" ]] && exit 0

T="tmux -S $SOCK"
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
CURRENT=$($T display-message -p '#{client_session}' 2>/dev/null || echo "")

# Collect deck names
NAMES=()
while IFS= read -r name; do
  [[ "$name" == "$DJ" || -z "$name" ]] && continue
  NAMES+=("$name")
done < <($T list-sessions -F "#{session_name}" 2>/dev/null)

COUNT=${#NAMES[@]}

if [[ $COUNT -eq 0 ]]; then
  echo "no decks  d=DJ"
elif [[ $COUNT -le 3 ]]; then
  # Show individual names
  OUT=""
  for name in "${NAMES[@]}"; do
    if [[ "$name" == "$CURRENT" ]]; then
      OUT+=" ●${name}"
    else
      OUT+=" ▸${name}"
    fi
  done
  echo "${OUT}  d=DJ"
else
  # Collapse to count, only show current if on a deck
  if [[ "$CURRENT" != "$DJ" && -n "$CURRENT" ]]; then
    echo "▸${COUNT} decks ●${CURRENT}  d=DJ"
  else
    echo "▸${COUNT} decks  d=DJ"
  fi
fi
