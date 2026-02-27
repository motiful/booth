#!/usr/bin/env bash
# booth-kill-joined.sh — Kill a joined deck and its origin session
# Called after confirm-before prompt. Finds the joined pane, kills it,
# then kills the origin session (including _booth_hold).
#
# Usage: booth-kill-joined.sh <socket-path>

SOCK="${1:?Usage: booth-kill-joined.sh <socket>}"
T="tmux -S $SOCK"

# Find the joined pane
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

[[ -z "$PANE" ]] && exit 0

# Unzoom if needed
ZOOMED=$($T display-message -p '#{window_zoomed_flag}' 2>/dev/null || echo "0")
[[ "$ZOOMED" == "1" ]] && $T resize-pane -Z

# Kill the joined pane (this kills the CC process inside it)
$T kill-pane -t "$PANE" 2>/dev/null || true

# Kill the origin session (includes _booth_hold and any other windows)
$T kill-session -t "$ORIGIN" 2>/dev/null || true

# Refresh status bar
$T refresh-client -S 2>/dev/null || true
