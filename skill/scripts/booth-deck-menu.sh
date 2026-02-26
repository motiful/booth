#!/usr/bin/env bash
# booth-deck-menu.sh — Generate tmux display-menu for deck selection
# Called from tmux keybindings. Lists all decks (excludes DJ).
#
# Usage: booth-deck-menu.sh <action>
# action:
#   look   — switch-client to deck (全屏看)
#   glance — split-pane, DJ stays visible (瞄一眼)
#   peek   — display-popup with booth-peek.sh (legacy)

set -euo pipefail

ACTION="${1:-look}"
SOCKET="${BOOTH_SOCKET:-booth}"
T="tmux -L $SOCKET"

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

# Single deck? Skip menu, act directly.
if [[ ${#DECKS[@]} -eq 1 ]]; then
  deck="${DECKS[0]}"
  case "$ACTION" in
    look)
      $T switch-client -t "$deck"
      ;;
    glance)
      $T split-window -h -t "$DJ" -l 50% "$T attach -t '$deck' -r"
      ;;
    peek)
      $T display-popup -E -w 120 -h 35 -T " deck: $deck " -b rounded \
        "BOOTH_SOCKET=$SOCKET bash ~/.claude/skills/booth-skill/scripts/booth-peek.sh '$deck'"
      ;;
  esac
  exit 0
fi

# Multiple decks — show menu
MENU_ARGS=(-T " Decks " -x C -y C)
KEY=1

for deck in "${DECKS[@]}"; do
  case "$ACTION" in
    look)
      CMD="switch-client -t ${deck}"
      ;;
    glance)
      CMD="split-window -h -t ${DJ} -l 50% \"$T attach -t '${deck}' -r\""
      ;;
    peek)
      CMD="display-popup -E -w 120 -h 35 -T ' deck: ${deck} ' -b rounded 'BOOTH_SOCKET=$SOCKET bash ~/.claude/skills/booth-skill/scripts/booth-peek.sh ${deck}'"
      ;;
  esac

  MENU_ARGS+=("${KEY}. ${deck}" "$KEY" "$CMD")
  KEY=$((KEY + 1))
  [[ $KEY -gt 9 ]] && KEY=0
done

$T display-menu "${MENU_ARGS[@]}"
