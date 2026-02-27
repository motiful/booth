#!/usr/bin/env bash
# booth-glance.sh — Live preview of a deck pane. Press any key to close.
# Runs inside a split pane; auto-closes when this script exits.
#
# Usage: booth-glance.sh <socket-path> <deck-name>

SOCK="${1:?Usage: booth-glance.sh <socket> <deck>}"
DECK="${2:?Missing deck name}"

# Hide typed characters
stty -echo 2>/dev/null
trap 'stty echo 2>/dev/null; exit' INT TERM EXIT

# Terminal dimensions for header bar
COLS=$(tput cols 2>/dev/null || echo 80)

while true; do
  clear
  # Header bar: inverted colors, deck name centered-ish
  TITLE=" 👁 $DECK "
  TITLE_LEN=${#TITLE}
  PAD=$(( (COLS - TITLE_LEN) / 2 ))
  PAD_STR=$(printf '%*s' "$PAD" '')
  printf '\033[7m%s%s%*s\033[0m\n' "$PAD_STR" "$TITLE" "$((COLS - PAD - TITLE_LEN))" ''

  # Show last lines of deck output (leave room for header + footer)
  ROWS=$(tput lines 2>/dev/null || echo 24)
  CAPTURE_LINES=$(( ROWS - 3 ))
  tmux -S "$SOCK" capture-pane -t "$DECK" -p -S "-${CAPTURE_LINES}" 2>/dev/null

  # Footer hint
  printf '\033[90m%*s\033[0m' "$COLS" '── any key to close ──'

  # Wait 1 second for input; any key → exit
  if read -t 1 -n 1 -s 2>/dev/null; then
    break
  fi
done
