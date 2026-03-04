#!/usr/bin/env bash
# Booth Editor Proxy — transparent interceptor for CC's Ctrl+G
#
# Normal use:  passes through to user's real editor (zero difference)
# Booth inject: saves user input, writes alert content, exits instantly (<50ms)
# Booth restore: writes saved input back, exits instantly (<50ms)
#
# State is per-pane (uses $TMUX_PANE) to avoid conflicts between DJ and decks.
# PID file: When running real editor, writes PID to state dir.
# Booth can detect Ctrl+G state by checking if editor-pid exists.

set -euo pipefail

# Per-pane state directory: ~/.booth/editor-state/pane-26/ (from %26)
PANE_SLUG="${TMUX_PANE:-unknown}"
PANE_SLUG="${PANE_SLUG//%/pane-}"
STATE_DIR="${BOOTH_EDITOR_STATE:-$HOME/.booth/editor-state/$PANE_SLUG}"
CC_TEMP_FILE="$1"

if [ -f "$STATE_DIR/action" ]; then
  ACTION=$(cat "$STATE_DIR/action")

  case "$ACTION" in
    inject)
      SAVE_PATH=$(cat "$STATE_DIR/save-path")
      ALERT_FILE=$(cat "$STATE_DIR/alert-file")

      # Save user's current input
      cp "$CC_TEMP_FILE" "$SAVE_PATH"

      # Write alert text into the CC temp file
      cp "$ALERT_FILE" "$CC_TEMP_FILE"

      # Clean up action files (NOT editor-pid)
      rm -f "$STATE_DIR/action" "$STATE_DIR/save-path" "$STATE_DIR/alert-file"
      exit 0
      ;;

    restore)
      RESTORE_PATH=$(cat "$STATE_DIR/restore-path")

      # Write saved input back
      if [ -f "$RESTORE_PATH" ]; then
        cp "$RESTORE_PATH" "$CC_TEMP_FILE"
        rm -f "$RESTORE_PATH"
      fi

      # Clean up
      rm -f "$STATE_DIR/action" "$STATE_DIR/restore-path"
      exit 0
      ;;

    *)
      rm -f "$STATE_DIR/action"
      ;;
  esac
fi

# Normal mode — proxy to user's real editor.
# Mirror CC's VC() auto-detection: $BOOTH_REAL_EDITOR > code > vi > nano
REAL_EDITOR="${BOOTH_REAL_EDITOR:-}"

if [ -z "$REAL_EDITOR" ]; then
  if command -v code >/dev/null 2>&1; then
    REAL_EDITOR="code"
  elif command -v vi >/dev/null 2>&1; then
    REAL_EDITOR="vi"
  elif command -v nano >/dev/null 2>&1; then
    REAL_EDITOR="nano"
  else
    echo "No editor found" >&2
    exit 1
  fi
fi

# Run editor as child process (NOT exec) so we can write PID for booth to detect.
cleanup() {
  rm -f "$STATE_DIR/editor-pid"
  # Remove dir if empty
  rmdir "$STATE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$STATE_DIR"

case "$REAL_EDITOR" in
  code)  code -w "$@" & ;;
  subl)  subl --wait "$@" & ;;
  *)     $REAL_EDITOR "$@" & ;;
esac

EDITOR_PID=$!
echo "$EDITOR_PID" > "$STATE_DIR/editor-pid"

wait $EDITOR_PID 2>/dev/null
