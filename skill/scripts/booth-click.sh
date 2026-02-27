#!/usr/bin/env bash
# booth-click.sh — Dispatch status bar clicks
# Called from MouseDown1Status binding. Routes clicks to appropriate handlers.
#
# Range values:
#   <session-name>  — DJ: switch-client; Deck: join-pane split
#   _z              — Zoom/unzoom toggle (fullscreen/shrink)
#   _b              — Break joined pane (close, return to background)
#   _k              — Kill joined deck (with confirm)
#
# Usage: booth-click.sh <socket-path> <range>

SOCK="${1:-}"
RANGE="${2:-}"
[[ -z "$SOCK" || -z "$RANGE" ]] && exit 0

T="tmux -S $SOCK"
SCRIPTS="$(cd "$(dirname "$0")" && pwd -P)"

case "$RANGE" in
  ""|left|right|status|window)
    exit 0
    ;;
  _z)
    $T resize-pane -Z
    ;;
  _b)
    bash "$SCRIPTS/booth-break.sh" "$SOCK"
    ;;
  _k)
    $T confirm-before -p 'Kill this deck? (y/n)' \
      "run-shell 'bash \"$SCRIPTS/booth-kill-joined.sh\" \"$SOCK\"'"
    ;;
  *)
    DJ=$($T show -gvq @booth-dj 2>/dev/null || echo "dj")
    if [[ "$RANGE" == "$DJ" ]]; then
      # Unzoom first — switch-client doesn't unzoom automatically
      ZOOMED=$($T display-message -p '#{window_zoomed_flag}' 2>/dev/null || echo "0")
      [[ "$ZOOMED" == "1" ]] && $T resize-pane -Z
      $T switch-client -t "$DJ"
    else
      bash "$SCRIPTS/booth-join.sh" "$SOCK" "$RANGE"
    fi
    ;;
esac
