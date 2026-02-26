#!/bin/bash
# spawn-child.sh — Create a tmux session and launch a child Claude Code instance
#
# Usage: spawn-child.sh --name <name> --dir <directory> [--worktree] [--prompt <initial-prompt>]
#
# --name:      tmux session name (also worktree branch name)
# --dir:       working directory (for worktree mode, the main repo directory)
# --worktree:  enable worktree mode, creates .claude/worktrees/<name>/
# --prompt:    optional initial prompt to send after child CC starts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCKET="${BOOTH_SOCKET:-booth}"
NAME=""
DIR=""
WORKTREE=false
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2 ;;
    --dir)    DIR="$2"; shift 2 ;;
    --worktree) WORKTREE=true; shift ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$NAME" || -z "$DIR" ]]; then
  echo "Error: --name and --dir are required" >&2
  exit 1
fi

# Check if session already exists
if tmux -L "$SOCKET" has-session -t "$NAME" 2>/dev/null; then
  echo "Error: session '$NAME' already exists" >&2
  exit 1
fi

WORK_DIR="$DIR"

# Worktree mode: create git worktree
if [[ "$WORKTREE" == true ]]; then
  WORKTREE_DIR="$DIR/.claude/worktrees/$NAME"
  if [[ -d "$WORKTREE_DIR" ]]; then
    echo "Worktree already exists at $WORKTREE_DIR"
  else
    mkdir -p "$DIR/.claude/worktrees"
    git -C "$DIR" worktree add "$WORKTREE_DIR" -b "$NAME" 2>&1
  fi
  WORK_DIR="$WORKTREE_DIR"
fi

# Resolve to absolute path
WORK_DIR="$(cd "$WORK_DIR" && pwd)"

# Create tmux session
tmux -L "$SOCKET" new-session -d -s "$NAME" -c "$WORK_DIR"

# Read child protocol
PROTOCOL_FILE="$SCRIPT_DIR/../references/child-protocol.md"
if [[ -f "$PROTOCOL_FILE" ]]; then
  PROTOCOL=$(cat "$PROTOCOL_FILE")
else
  echo "Warning: child-protocol.md not found, launching without protocol" >&2
  PROTOCOL=""
fi

# Launch claude in the tmux session
if [[ -n "$PROTOCOL" ]]; then
  # Escape single quotes in protocol for shell
  ESCAPED_PROTOCOL="${PROTOCOL//\'/\'\\\'\'}"
  tmux -L "$SOCKET" send-keys -t "$NAME" "claude --append-system-prompt '${ESCAPED_PROTOCOL}'" Enter
else
  tmux -L "$SOCKET" send-keys -t "$NAME" "claude" Enter
fi

# Wait for claude to start (poll for prompt indicator, timeout 15s)
TIMEOUT=15
ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  OUTPUT=$(tmux -L "$SOCKET" capture-pane -t "$NAME" -p -S -5 2>/dev/null || true)
  # Check for claude's input indicator (> prompt or similar)
  if echo "$OUTPUT" | grep -qE '^\s*>' 2>/dev/null; then
    break
  fi
done

if [[ $ELAPSED -ge $TIMEOUT ]]; then
  echo "Warning: claude may not have started within ${TIMEOUT}s" >&2
fi

# Send initial prompt if provided
if [[ -n "$PROMPT" ]]; then
  sleep 2
  "$SCRIPT_DIR/send-to-child.sh" "$NAME" "$PROMPT"
fi

# Notify DJ about the new deck (event-driven — DJ only hears when something happens)
DJ_SESSION=$( tmux -L "$SOCKET" show -gvq @booth-dj 2>/dev/null || echo "dj" )
if tmux -L "$SOCKET" has-session -t "$DJ_SESSION" 2>/dev/null; then
  tmux -L "$SOCKET" send-keys -t "$DJ_SESSION" -l "[booth-event] deck-created name=$NAME dir=$WORK_DIR"
  sleep 0.3
  tmux -L "$SOCKET" send-keys -t "$DJ_SESSION" Enter
fi

echo "session=$NAME"
echo "dir=$WORK_DIR"
echo "worktree=$WORKTREE"
