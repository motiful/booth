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

# display-menu for a deck
# -x M -y S: position at mouse x, status line y
# Labels: clear Chinese+English, parenthesis letters are keyboard shortcuts for the menu
$T display-menu -T " ${DECK} " -x M -y S \
  "进入 (全屏切换)"   s "switch-client -t '${DECK}'" \
  "预览 (浮窗,ESC关)" g "display-popup -w 80% -h 75% -E -T ' ${DECK} ' \"TMUX='' tmux -S '${SOCK}' attach -t '${DECK}' -r\"" \
  "" \
  "发指令"            m "command-prompt -p '发送到 ${DECK}:' \"run-shell 'bash ${SKILL_DIR}/send-to-child.sh \\\"${SOCK}\\\" \\\"${DECK}\\\" \\\"%%\\\"'\"" \
  "" \
  "#[fg=colour196]Kill (销毁)" k "confirm-before -p 'Kill deck ${DECK}? (y/n)' 'kill-session -t ${DECK}'"
