#!/bin/bash
# spawn-child.sh — Create a tmux session and launch a child Claude Code instance
#
# Usage: spawn-child.sh --name <name> --dir <directory> [--worktree] [--prompt <initial-prompt>]
#        [--system-prompt-file <path>]
#
# --name:                tmux session name (also worktree branch name)
# --dir:                 working directory (for worktree mode, the main repo directory)
# --worktree:            enable worktree mode, creates .claude/worktrees/<name>/
# --prompt:              optional initial prompt to send after child CC starts
# --system-prompt-file:  path to file with additional system prompt (appended after child protocol)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Auto-detect socket: extract from $TMUX env (set when running inside tmux), else fall back
if [[ -n "${BOOTH_SOCKET:-}" ]]; then
  SOCKET="$BOOTH_SOCKET"
elif [[ -n "${TMUX:-}" ]]; then
  # TMUX=/path/to/socket,pid,pane — extract socket name from path
  SOCKET="$(basename "${TMUX%%,*}")"
else
  SOCKET="booth"
fi
NAME=""
DIR=""
WORKTREE=false
PROMPT=""
SYSTEM_PROMPT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2 ;;
    --dir)    DIR="$2"; shift 2 ;;
    --worktree) WORKTREE=true; shift ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --system-prompt-file) SYSTEM_PROMPT_FILE="$2"; shift 2 ;;
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

# Snapshot existing JSONL files before spawning CC
# (to detect which new JSONL file belongs to THIS deck)
_ENCODED_DIR=$(printf '%s' "$WORK_DIR" | sed 's|/|-|g; s|\.|-|g')
_JSONL_DIR="$HOME/.claude/projects/$_ENCODED_DIR"
_PRE_JSONLS=""
if [[ -d "$_JSONL_DIR" ]]; then
  _PRE_JSONLS=$(ls "$_JSONL_DIR"/*.jsonl 2>/dev/null | sort || true)
fi

# Create tmux session
tmux -L "$SOCKET" new-session -d -s "$NAME" -c "$WORK_DIR"

# Capture the stable pane ID (%N) — survives join-pane/break-pane operations
PANE_ID=$(tmux -L "$SOCKET" list-panes -t "$NAME" -F '#{pane_id}' | head -1)

# Read child protocol
PROTOCOL_FILE="$SCRIPT_DIR/../references/child-protocol.md"
if [[ -f "$PROTOCOL_FILE" ]]; then
  PROTOCOL=$(cat "$PROTOCOL_FILE")
else
  echo "Warning: child-protocol.md not found, launching without protocol" >&2
  PROTOCOL=""
fi

# Combine child protocol with additional system prompt (if provided)
if [[ -n "$SYSTEM_PROMPT_FILE" && -f "$SYSTEM_PROMPT_FILE" ]]; then
  EXTRA_PROMPT=$(cat "$SYSTEM_PROMPT_FILE")
  if [[ -n "$PROTOCOL" ]]; then
    PROTOCOL="${PROTOCOL}

---

${EXTRA_PROMPT}"
  else
    PROTOCOL="$EXTRA_PROMPT"
  fi
fi

# Build claude command with flags
# Write system prompt to temp file to avoid shell escaping issues with send-keys
CLAUDE_CMD="claude"
if [[ -n "$PROTOCOL" ]]; then
  PROTOCOL_TMP=$(mktemp /tmp/booth-prompt-XXXXXX)
  printf '%s' "$PROTOCOL" > "$PROTOCOL_TMP"
  CLAUDE_CMD+=" --append-system-prompt \"\$(cat '$PROTOCOL_TMP')\""
fi
# Launch claude in the tmux session (unset CLAUDECODE to avoid nesting detection)
tmux -L "$SOCKET" send-keys -t "$NAME" "unset CLAUDECODE && $CLAUDE_CMD" Enter

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

# --- Register pane ID immediately (available right after new-session) ---
# Use @booth-root (DJ's CWD) for .booth/ path — $DIR is the deck's --dir, which may differ
_BOOTH_ROOT=$(tmux -L "$SOCKET" show -gvq @booth-root 2>/dev/null || echo "$DIR")
_DECKS_FILE="$_BOOTH_ROOT/.booth/decks.json"
if [[ -f "$_DECKS_FILE" ]]; then
  node -e "
    const fs = require('fs');
    const f = process.argv[1];
    const name = process.argv[2];
    const paneId = process.argv[3];
    let data = { decks: [] };
    try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
    const deck = data.decks.find(d => d.name === name);
    if (deck && paneId) deck.paneId = paneId;
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, f);
  " "$_DECKS_FILE" "$NAME" "$PANE_ID" 2>/dev/null || true
fi
echo "paneId=$PANE_ID"

# --- Detect JSONL in background (CC may take 30-60s to create it) ---
# Non-blocking: spawn a background process that polls for the new JSONL file,
# then writes jsonlPath to decks.json when found. Max wait: 90 seconds.
(
  _MAX_WAIT=90
  _WAITED=0
  _JSONL_PATH=""
  while [[ $_WAITED -lt $_MAX_WAIT ]]; do
    sleep 2
    _WAITED=$((_WAITED + 2))
    if [[ -d "$_JSONL_DIR" ]]; then
      _POST_JSONLS=$(ls "$_JSONL_DIR"/*.jsonl 2>/dev/null | sort || true)
      _NEW_JSONL=$(comm -13 <(echo "$_PRE_JSONLS") <(echo "$_POST_JSONLS") 2>/dev/null | head -1)
      if [[ -n "$_NEW_JSONL" ]]; then
        _JSONL_PATH="$_NEW_JSONL"
        break
      fi
    fi
  done
  if [[ -n "$_JSONL_PATH" && -f "$_DECKS_FILE" ]]; then
    node -e "
      const fs = require('fs');
      const f = process.argv[1];
      const name = process.argv[2];
      const jp = process.argv[3];
      let data = { decks: [] };
      try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
      const deck = data.decks.find(d => d.name === name);
      if (deck) deck.jsonlPath = jp;
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, f);
    " "$_DECKS_FILE" "$NAME" "$_JSONL_PATH" 2>/dev/null
  fi
) &
echo "jsonlPath=(detecting in background, max 90s)"

# Send initial prompt if provided
if [[ -n "$PROMPT" ]]; then
  sleep 2
  "$SCRIPT_DIR/send-to-child.sh" --pane "$PANE_ID" "$NAME" "$PROMPT"
fi

# NOTE: Deck registration, alert writing, and watchdog startup are handled
# automatically by tmux session-created hook → on-session-event.sh.
# The new-session call above triggers the hook. No manual work needed here.

echo "session=$NAME"
echo "dir=$WORK_DIR"
echo "worktree=$WORKTREE"
