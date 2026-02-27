#!/usr/bin/env bash
# booth-break.sh — Return a joined deck pane back to its original session
# Finds the pane with @booth_origin in the current window, breaks it back.
#
# Usage: booth-break.sh <socket-path>

SOCK="${1:?Usage: booth-break.sh <socket>}"
T="tmux -S $SOCK"

# Find the joined pane in the current window
PANE=""
ORIGIN=""
for pid in $($T list-panes -F '#{pane_id}' 2>/dev/null); do
  orig=$($T show-options -pqv -t "$pid" @booth_origin 2>/dev/null) || true
  if [[ -n "$orig" ]]; then
    PANE="$pid"
    ORIGIN="$orig"
    break
  fi
done

[[ -z "$PANE" ]] && {
  $T display-message "No joined deck to close"
  exit 1
}

# Unzoom first if the window is zoomed (prevents layout issues)
ZOOMED=$($T display-message -p '#{window_zoomed_flag}' 2>/dev/null || echo "0")
[[ "$ZOOMED" == "1" ]] && $T resize-pane -Z

# Break pane back to its origin session
$T break-pane -d -s "$PANE" -t "$ORIGIN:"

# Clean up the hold window (no longer needed)
$T kill-window -t "$ORIGIN:_booth_hold" 2>/dev/null || true

# Clear the origin tag
$T set-option -pu -t "$PANE" @booth_origin 2>/dev/null || true

# Refresh status bar
$T refresh-client -S 2>/dev/null || true
