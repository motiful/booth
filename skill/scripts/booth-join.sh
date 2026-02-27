#!/usr/bin/env bash
# booth-join.sh — Join a deck pane into the current window as an interactive split
# The pane is MOVED (not copied) — the deck session keeps a hold window alive.
# Use booth-break.sh to return the pane to its original session.
#
# Usage: booth-join.sh <socket-path> <deck-name>

SOCK="${1:?Usage: booth-join.sh <socket> <deck>}"
DECK="${2:?Missing deck name}"

T="tmux -S $SOCK"
SCRIPTS="$(cd "$(dirname "$0")" && pwd -P)"

# Check deck session exists
$T has-session -t "$DECK" 2>/dev/null || {
  $T display-message "Deck '$DECK' not found"
  exit 1
}

# If there's already a joined pane in this window, handle it
for pid in $($T list-panes -F '#{pane_id}' 2>/dev/null); do
  origin=$($T show-options -pqv -t "$pid" @booth_origin 2>/dev/null) || true
  if [[ -n "$origin" ]]; then
    if [[ "$origin" == "$DECK" ]]; then
      # Same deck already joined — just select it
      $T select-pane -t "$pid"
      exit 0
    fi
    # Different deck joined — break it first
    bash "$SCRIPTS/booth-break.sh" "$SOCK"
    break
  fi
done

# Find the deck's CC pane (skip _booth_hold windows)
DECK_PANE=""
while IFS=$'\t' read -r wname pid; do
  if [[ "$wname" != "_booth_hold" ]]; then
    DECK_PANE="$pid"
    break
  fi
done < <($T list-panes -s -t "$DECK" -F $'#{window_name}\t#{pane_id}' 2>/dev/null)

[[ -z "$DECK_PANE" ]] && {
  $T display-message "No panes in '$DECK'"
  exit 1
}

# Tag pane with its origin session (for booth-break.sh to find later)
$T set-option -p -t "$DECK_PANE" @booth_origin "$DECK"

# Hold window keeps the deck session alive when its only pane is moved out
$T new-window -d -t "$DECK:" -n _booth_hold 'tail -f /dev/null' 2>/dev/null || true

# Smart split direction: wide terminal → vertical (side-by-side), tall → horizontal
W=$($T display-message -p '#{pane_width}' 2>/dev/null || echo 80)
H=$($T display-message -p '#{pane_height}' 2>/dev/null || echo 24)

if [ "$W" -gt "$(( H * 2 ))" ]; then
  $T join-pane -s "$DECK_PANE" -h -l 50%
else
  $T join-pane -s "$DECK_PANE" -v -l 50%
fi

# Focus the joined pane so user can interact immediately
$T select-pane -t "$DECK_PANE"

# Force status bar refresh to show controls
$T refresh-client -S 2>/dev/null || true
