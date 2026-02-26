#!/usr/bin/env bash
# booth-context-menu.sh — Right-click context menu for a deck
# Called from MouseDown3Status binding when #{mouse_status_range} is a deck name.
#
# Usage: booth-context-menu.sh <deck-name> <socket-path>

set -euo pipefail

DECK="${1:?Usage: booth-context-menu.sh <deck> <socket-path>}"
SOCK="${2:?Missing socket path}"

T="tmux -S $SOCK"
DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")

# DJ session gets a simpler menu
if [[ "$DECK" == "$DJ" ]]; then
  $T display-menu -T " DJ " -x M -y S \
    "Switch to DJ" s "switch-client -t '${DJ}'"
  exit 0
fi

SKILL_DIR="$HOME/.claude/skills/booth-skill/scripts"

# Build the glance command
GLANCE="TMUX='' tmux -S '${SOCK}' attach -t '${DECK}'"

# display-menu for a deck
# -x M -y S: position at mouse x, status line y
$T display-menu -T " ${DECK} " -x M -y S \
  "看 Switch"       s "switch-client -t '${DECK}'" \
  "瞄 Glance"       g "split-window -h -l 50% \"${GLANCE}\"" \
  "" \
  "Send message"    m "command-prompt -p 'Send to ${DECK}:' \"run-shell 'bash ${SKILL_DIR}/send-to-child.sh \\\"${SOCK}\\\" \\\"${DECK}\\\" \\\"%%\\\"'\"" \
  "" \
  "#[fg=colour196]Kill" k "confirm-before -p 'Kill deck ${DECK}? (y/n)' 'kill-session -t ${DECK}'"
