#!/bin/bash
# deck-status.sh — Query the current state of a Booth deck
#
# Usage: deck-status.sh <deck-name>
#
# Output: working | idle | error | needs-attention | waiting-approval | unknown
#
# Detection strategy:
#   1. Find deck's JSONL file (via tmux CWD → encoded project path → newest .jsonl)
#   2. Read last 50 lines of JSONL → parse with jsonl-state.py (oneshot)
#   3. Fallback: if JSONL not found → capture-pane + detect-state.sh (legacy)
#
# JSONL can't detect waiting-approval (it's a terminal UI event).
# If JSONL says "idle", we double-check capture-pane for Allow/Deny prompts.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL_STATE_PY="$SCRIPT_DIR/jsonl-state.py"
DETECT_STATE="$SCRIPT_DIR/detect-state.sh"
SOCKET="${BOOTH_SOCKET:-booth}"

if [[ $# -lt 1 ]]; then
  echo "Usage: deck-status.sh <deck-name>" >&2
  exit 1
fi

DECK_NAME="$1"

# Check session exists
if ! tmux -L "$SOCKET" has-session -t "$DECK_NAME" 2>/dev/null; then
  echo "unknown"
  exit 0
fi

# --- Find JSONL file ---

# Get deck's working directory from tmux
DECK_CWD=$(tmux -L "$SOCKET" display-message -t "$DECK_NAME" -p "#{pane_current_path}" 2>/dev/null || true)

JSONL_PATH=""
if [[ -n "$DECK_CWD" ]]; then
  # Encode path: /foo/bar/.baz → -foo-bar--baz
  ENCODED=$(echo "$DECK_CWD" | tr '/.' '--')
  PROJECT_DIR="$HOME/.claude/projects/$ENCODED"

  if [[ -d "$PROJECT_DIR" ]]; then
    # Find newest .jsonl file (top-level only, not subagents)
    JSONL_PATH=$(ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null | head -1 || true)
  fi
fi

# --- Detect state via JSONL ---

if [[ -n "$JSONL_PATH" && -f "$JSONL_PATH" ]]; then
  STATE=$(tail -50 "$JSONL_PATH" | python3 "$JSONL_STATE_PY" oneshot 2>/dev/null || echo "unknown")

  # JSONL can't detect waiting-approval. If state is idle/unknown,
  # double-check capture-pane for Allow/Deny prompts.
  if [[ "$STATE" == "idle" || "$STATE" == "unknown" ]]; then
    PANE=$(tmux -L "$SOCKET" capture-pane -t "$DECK_NAME" -p -S -15 2>/dev/null || true)
    if echo "$PANE" | grep -qE '(Allow|Deny)' 2>/dev/null; then
      if echo "$PANE" | grep -qE '(Bash|Write|Edit|Read|Glob|Grep|WebFetch|WebSearch|Task|NotebookEdit|LSP)' 2>/dev/null; then
        STATE="waiting-approval"
      fi
    fi
  fi

  echo "$STATE"
  exit 0
fi

# --- Fallback: capture-pane + detect-state.sh (legacy) ---

if [[ -x "$DETECT_STATE" ]]; then
  PANE=$(tmux -L "$SOCKET" capture-pane -t "$DECK_NAME" -p -S -30 2>/dev/null || echo "")
  STATE=$(echo "$PANE" | bash "$DETECT_STATE" 2>/dev/null || echo "unknown")
  echo "$STATE"
  exit 0
fi

echo "unknown"
