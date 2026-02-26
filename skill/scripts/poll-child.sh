#!/bin/bash
# poll-child.sh — Deck state monitor with change detection
#
# Usage: poll-child.sh <session-name> [--lines <N>] [--prev-hash <hash>]
#
# Output (tab-separated):
#   changed<TAB><new-hash><TAB><captured-text>
#   unchanged<TAB><hash>
#
# Uses deck-status.sh for state detection (JSONL primary, capture-pane fallback).
# The --jsonl flag is accepted for backward compat but ignored (deck-status.sh
# discovers JSONL paths automatically).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCKET="${BOOTH_SOCKET:-booth}"
NAME=""
LINES=30
PREV_HASH=""
JSONL_PATH=""

# Parse args
if [[ $# -lt 1 ]]; then
  echo "Error: session name required" >&2
  exit 1
fi
NAME="$1"; shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lines)     LINES="$2"; shift 2 ;;
    --prev-hash) PREV_HASH="$2"; shift 2 ;;
    --jsonl)     JSONL_PATH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Check session exists
if ! tmux -L "$SOCKET" has-session -t "$NAME" 2>/dev/null; then
  echo "Error: session '$NAME' does not exist" >&2
  exit 1
fi

# --- Capture pane for change detection ---
OUTPUT=$(tmux -L "$SOCKET" capture-pane -t "$NAME" -p -S "-${LINES}" 2>/dev/null || true)

# Compute hash for change detection
NEW_HASH=$(printf '%s' "$OUTPUT" | shasum -a 256 | cut -d' ' -f1)

# Check if pane changed
PANE_CHANGED=true
if [[ -n "$PREV_HASH" && "$NEW_HASH" == "$PREV_HASH" ]]; then
  PANE_CHANGED=false
fi

# --- State detection via deck-status.sh (JSONL primary, capture-pane fallback) ---
FINAL_STATE=""
if [[ "$PANE_CHANGED" == true ]]; then
  FINAL_STATE=$("$SCRIPT_DIR/deck-status.sh" "$NAME" 2>/dev/null || echo "unknown")
fi

# Output
if [[ "$PANE_CHANGED" == false ]]; then
  printf 'unchanged\t%s\n' "$NEW_HASH"
else
  printf 'changed\t%s\t%s\n' "$NEW_HASH" "$OUTPUT"
fi

# State on stderr for convenience
if [[ -n "$FINAL_STATE" ]]; then
  echo "state=$FINAL_STATE" >&2
fi
