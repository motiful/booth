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

# Hide cursor during rendering
tput civis 2>/dev/null
trap 'tput cnorm 2>/dev/null' EXIT

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
  tput cnorm 2>/dev/null  # show cursor for less
  tmux -L "$SOCKET" capture-pane -t "$DECK_NAME" -p -S - 2>/dev/null \
    | less -R +G
  tput civis 2>/dev/null  # hide again
}

# --- Takeover: switch client to deck session ---
do_takeover() {
  tmux -L "$SOCKET" switch-client -t "$DECK_NAME" 2>/dev/null
  exit 0
}

# --- Separator line (cached) ---
draw_separator() {
  local cols="${1:-80}"
  printf "${DIM}"
  printf '─%.0s' $(seq 1 "$cols")
  printf "${RESET}\n"
}

# --- Main loop ---
# Use cursor positioning instead of clear — preserves tmux copy-mode scrollback
FIRST_DRAW=true

while true; do
  # Check if deck still exists
  if ! tmux -L "$SOCKET" has-session -t "$DECK_NAME" 2>/dev/null; then
    clear
    echo -e "${DIM}  Deck '$DECK_NAME' is no longer running.${RESET}"
    echo ""
    echo "  Press any key to close."
    tput cnorm 2>/dev/null
    read -rsn1
    exit 0
  fi

  # Get terminal dimensions
  COLS=$(tput cols 2>/dev/null || echo 80)
  TERM_LINES=$(tput lines 2>/dev/null || echo 24)
  CONTENT_LINES=$((TERM_LINES - 4))  # reserve for header + footer

  if $FIRST_DRAW; then
    clear
    FIRST_DRAW=false
  else
    # Move cursor to top-left, don't clear — lets tmux scrollback survive
    tput cup 0 0
  fi

  # Header
  echo -e "${CYAN}${BOLD}  ◉ deck: ${DECK_NAME}${RESET}${DIM}  (live · 2s)${RESET}"
  draw_separator "$COLS"

  # Capture pane content (last N lines)
  CAPTURED=$(tmux -L "$SOCKET" capture-pane -t "$DECK_NAME" -p -S -"$CONTENT_LINES" 2>/dev/null || echo "  (capture failed)")

  # Pad to fill screen (prevents old content bleeding through)
  CAPTURED_LINES=$(echo "$CAPTURED" | wc -l)
  echo "$CAPTURED"
  PADDING=$((CONTENT_LINES - CAPTURED_LINES))
  if [[ $PADDING -gt 0 ]]; then
    for ((i=0; i<PADDING; i++)); do
      tput el  # clear to end of line
      echo ""
    done
  fi

  # Footer
  draw_separator "$COLS"
  tput el
  echo -ne "  ${GREEN}q${RESET}:close  ${RED}k${RESET}:kill  ${CYAN}s${RESET}:scroll  ${YELLOW}t${RESET}:takeover"

  # Wait for input (2 second timeout for auto-refresh)
  read -rsn1 -t 2 key || key=""

  case "$key" in
    q|Q)
      exit 0
      ;;
    k|K)
      confirm_kill
      FIRST_DRAW=true
      ;;
    s|S)
      scroll_mode
      FIRST_DRAW=true
      ;;
    t|T)
      do_takeover
      ;;
  esac
done
