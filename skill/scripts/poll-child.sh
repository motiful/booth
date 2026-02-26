#!/bin/bash
# poll-child.sh — Dual-channel deck state monitor (JSONL + capture-pane)
#
# Usage: poll-child.sh <session-name> [--lines <N>] [--prev-hash <hash>] [--jsonl <path>]
#
# Output (tab-separated):
#   changed<TAB><new-hash><TAB><captured-text>
#   unchanged<TAB><hash>
#
# When --jsonl is provided, uses JSONL as primary signal source.
# Falls back to capture-pane for states JSONL can't detect (waiting-approval).
# If --jsonl is not provided, behaves exactly like the original (capture-pane only).

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

# --- Channel 1: JSONL (precise, if available) ---
JSONL_STATE=""
if [[ -n "$JSONL_PATH" ]]; then
  JSONL_STATE=$("$SCRIPT_DIR/jsonl-monitor.sh" "$JSONL_PATH" 2>/dev/null || echo "unknown")
fi

# --- Channel 2: capture-pane (universal fallback) ---
OUTPUT=$(tmux -L "$SOCKET" capture-pane -t "$NAME" -p -S "-${LINES}" 2>/dev/null || true)

# Compute hash for change detection (always based on capture-pane)
NEW_HASH=$(printf '%s' "$OUTPUT" | shasum -a 256 | cut -d' ' -f1)

# Check if pane changed
PANE_CHANGED=true
if [[ -n "$PREV_HASH" && "$NEW_HASH" == "$PREV_HASH" ]]; then
  PANE_CHANGED=false
fi

# --- Merge signals ---
# JSONL can't detect waiting-approval (it's a terminal UI event).
# So even if JSONL says "idle", we still need capture-pane to check for Allow/Deny.
PANE_STATE=""
if [[ "$PANE_CHANGED" == true ]]; then
  PANE_STATE=$(echo "$OUTPUT" | "$SCRIPT_DIR/detect-state.sh" 2>/dev/null || echo "unknown")
fi

# Decision logic:
# 1. If pane detects waiting-approval → always trust it (JSONL can't see this)
# 2. If JSONL has a definitive state (working/idle/needs-attention) → use it
# 3. Otherwise → use pane state
FINAL_STATE=""
if [[ "$PANE_STATE" == "waiting-approval" ]]; then
  FINAL_STATE="waiting-approval"
elif [[ -n "$JSONL_STATE" && "$JSONL_STATE" != "unknown" ]]; then
  FINAL_STATE="$JSONL_STATE"
elif [[ -n "$PANE_STATE" && "$PANE_STATE" != "unknown" ]]; then
  FINAL_STATE="$PANE_STATE"
fi

# Output
if [[ "$PANE_CHANGED" == false && -z "$JSONL_STATE" ]]; then
  # No JSONL, pane unchanged → unchanged
  printf 'unchanged\t%s\n' "$NEW_HASH"
elif [[ "$PANE_CHANGED" == false && -n "$JSONL_STATE" && "$JSONL_STATE" != "unknown" ]]; then
  # Pane unchanged but JSONL has info → report as changed with JSONL state
  printf 'changed\t%s\t%s\n' "$NEW_HASH" "$OUTPUT"
else
  printf 'changed\t%s\t%s\n' "$NEW_HASH" "$OUTPUT"
fi

# If we have a final state, append it as a 4th field for convenience
# Booth can use this to skip running detect-state.sh separately
if [[ -n "$FINAL_STATE" ]]; then
  # Re-output with state appended (overwrite previous output)
  # Actually, to keep backward compat, we output state on stderr
  echo "state=$FINAL_STATE" >&2
fi
