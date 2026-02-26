#!/usr/bin/env bash
# booth-peek.sh — Floating window deck viewer for Booth
# Runs INSIDE tmux display-popup. Shows capture-pane output with controls.
#
# Usage: booth-peek.sh <deck-name>
# Controls: q=close  k=kill  s=scroll  t=takeover

set -euo pipefail

DECK_NAME="${1:?Usage: booth-peek.sh <deck-name>}"
SOCKET="${BOOTH_SOCKET:-booth}"

# --- Validate deck exists ---
if ! tmux -L "$SOCKET" has-session -t "$DECK_NAME" 2>/dev/null; then
  echo "Deck '$DECK_NAME' not found on socket '$SOCKET'."
  echo ""
  echo "Available sessions:"
  tmux -L "$SOCKET" list-sessions 2>/dev/null || echo "  (none)"
  echo ""
  echo "Press any key to close."
  read -rsn1
  exit 1
fi

# --- Colors ---
BOLD="\033[1m"
DIM="\033[2m"
RESET="\033[0m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
GREEN="\033[32m"

# --- Confirm prompt for kill ---
confirm_kill() {
  clear
  echo -e "${RED}${BOLD}  Kill deck '$DECK_NAME'?${RESET}"
  echo ""
  echo -e "  This will terminate the CC session and all its work."
  echo -e "  (CC session can be resumed later with claude --resume)"
  echo ""
  echo -e "  ${BOLD}y${RESET} = yes, kill it    ${BOLD}n${RESET} = cancel"
  echo ""

  while true; do
    read -rsn1 key
    case "$key" in
      y|Y)
        tmux -L "$SOCKET" kill-session -t "$DECK_NAME" 2>/dev/null
        clear
        echo -e "${RED}  Deck '$DECK_NAME' killed.${RESET}"
        echo ""
        echo "  Press any key to close."
        read -rsn1
        exit 0
        ;;
      n|N|"")
        return
        ;;
    esac
  done
}

# --- Scroll mode: full scrollback in less ---
scroll_mode() {
  tmux -L "$SOCKET" capture-pane -t "$DECK_NAME" -p -S - 2>/dev/null \
    | less -R +G
  # +G starts at bottom (most recent output)
  # When user quits less, returns to live view
}

# --- Takeover: switch client to deck session ---
do_takeover() {
  # switch-client changes what session this tmux client displays
  # The popup closes (script exits), terminal shows the deck directly
  tmux -L "$SOCKET" switch-client -t "$DECK_NAME" 2>/dev/null
  exit 0
}

# --- Main loop ---
while true; do
  # Check if deck still exists
  if ! tmux -L "$SOCKET" has-session -t "$DECK_NAME" 2>/dev/null; then
    clear
    echo -e "${DIM}  Deck '$DECK_NAME' is no longer running.${RESET}"
    echo ""
    echo "  Press any key to close."
    read -rsn1
    exit 0
  fi

  # Get terminal dimensions
  COLS=$(tput cols 2>/dev/null || echo 80)
  LINES=$(tput lines 2>/dev/null || echo 24)
  CONTENT_LINES=$((LINES - 4))  # reserve for header + footer

  # Clear and draw
  clear

  # Header
  echo -e "${CYAN}${BOLD}  ◉ deck: ${DECK_NAME}${RESET}${DIM}  (live · 2s refresh)${RESET}"
  echo -e "${DIM}$(printf '─%.0s' $(seq 1 "$COLS"))${RESET}"

  # Capture pane content (last N lines)
  tmux -L "$SOCKET" capture-pane -t "$DECK_NAME" -p -S -"$CONTENT_LINES" 2>/dev/null || echo "  (capture failed)"

  # Footer
  echo ""
  echo -e "${DIM}$(printf '─%.0s' $(seq 1 "$COLS"))${RESET}"
  echo -ne "  ${GREEN}q${RESET}:关闭  ${RED}k${RESET}:杀掉  ${CYAN}s${RESET}:滚动  ${YELLOW}t${RESET}:接管"

  # Wait for input (2 second timeout for auto-refresh)
  read -rsn1 -t 2 key || key=""

  case "$key" in
    q|Q)
      exit 0
      ;;
    k|K)
      confirm_kill
      ;;
    s|S)
      scroll_mode
      ;;
    t|T)
      do_takeover
      ;;
  esac
done
