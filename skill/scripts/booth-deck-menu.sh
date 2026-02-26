#!/usr/bin/env bash
# booth-deck-menu.sh — Generate tmux display-menu for deck selection
# Called from tmux keybindings. Lists all decks (excludes DJ).
#
# Usage: booth-deck-menu.sh <action> [<socket-path>]
# action:
#   look   — switch-client to deck
#   glance — split-pane with live deck viewer (booth-peek.sh) on right

set -euo pipefail

ACTION="${1:-look}"
SOCK="${2:-}"

# Derive socket: explicit arg > env var > fallback
if [[ -n "$SOCK" ]]; then
  T="tmux -S $SOCK"
  # Extract socket name from path for scripts that use -L
  SOCK_NAME="$(basename "$SOCK")"
elif [[ -n "${BOOTH_SOCKET:-}" ]]; then
  T="tmux -L $BOOTH_SOCKET"
  SOCK_NAME="$BOOTH_SOCKET"
else
  T="tmux"
  SOCK_NAME=""
fi

PEEK_SCRIPT="$HOME/.claude/skills/booth-skill/scripts/booth-peek.sh"
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

# Helper: build the glance shell command for a given deck
# Attach directly to the real session (TMUX='' bypasses nesting check)
glance_cmd() {
  local deck="$1"
  if [[ -n "$SOCK" ]]; then
    echo "TMUX='' tmux -S '$SOCK' attach -t '$deck'"
  elif [[ -n "$SOCK_NAME" ]]; then
    echo "TMUX='' tmux -L '$SOCK_NAME' attach -t '$deck'"
  else
    echo "TMUX='' tmux attach -t '$deck'"
  fi
}

# Single deck? Skip menu, act directly.
if [[ ${#DECKS[@]} -eq 1 ]]; then
  deck="${DECKS[0]}"
  case "$ACTION" in
    look)
      $T switch-client -t "$deck"
      ;;
    glance)
      $T split-window -h -l 50% "$(glance_cmd "$deck")"
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
      CMD="split-window -h -l 50% \"$(glance_cmd "$deck")\""
      ;;
  esac

  MENU_ARGS+=("${KEY}. ${deck}" "$KEY" "$CMD")
  KEY=$((KEY + 1))
  [[ $KEY -gt 9 ]] && KEY=0
done

$T display-menu "${MENU_ARGS[@]}"
