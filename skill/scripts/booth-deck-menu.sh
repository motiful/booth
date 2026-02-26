#!/usr/bin/env bash
# booth-deck-menu.sh — Generate tmux display-menu for deck selection
# Called from tmux keybindings. Lists all decks (excludes DJ).
#
# Usage: booth-deck-menu.sh <action> [socket-path]
# action: peek | switch
#   peek   — open booth-peek.sh in display-popup
#   switch — switch-client to the deck directly

set -euo pipefail

ACTION="${1:-peek}"
SOCK_PATH="${2:-}"

if [[ -n "$SOCK_PATH" && -S "$SOCK_PATH" ]]; then
  T="tmux -S $SOCK_PATH"
else
  SOCKET="${BOOTH_SOCKET:-booth}"
  T="tmux -L $SOCKET"
fi

DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")

# Collect deck names (everything except DJ)
DECKS=()
while IFS= read -r name; do
  [[ "$name" == "$DJ" ]] && continue
  [[ -z "$name" ]] && continue
  DECKS+=("$name")
done < <($T list-sessions -F "#{session_name}" 2>/dev/null)

if [[ ${#DECKS[@]} -eq 0 ]]; then
  $T display-message "No decks running."
  exit 0
fi

# Build display-menu arguments
MENU_ARGS=(-T " Decks " -x C -y C)
KEY=1

for deck in "${DECKS[@]}"; do
  case "$ACTION" in
    peek)
      CMD="display-popup -E -w 120 -h 35 -T ' deck: ${deck} ' -b rounded 'BOOTH_SOCKET=\$BOOTH_SOCKET bash ~/.claude/skills/booth-skill/scripts/booth-peek.sh ${deck}'"
      ;;
    switch)
      CMD="switch-client -t ${deck}"
      ;;
  esac

  MENU_ARGS+=("${KEY}. ${deck}" "$KEY" "$CMD")

  KEY=$((KEY + 1))
  # tmux display-menu supports 0-9 as shortcut keys
  [[ $KEY -gt 9 ]] && KEY=0
done

$T display-menu "${MENU_ARGS[@]}"
