#!/bin/bash
# booth-plan.sh — Plan-then-execute workflow for Booth decks
#
# Usage:
#   booth-plan.sh spawn   --name <name> --dir <dir> --task <description>
#   booth-plan.sh execute --name <name> --dir <dir>
#   booth-plan.sh status  --name <name> --dir <dir>
#   booth-plan.sh approve --name <name> --dir <dir>
#
# Subcommands:
#   spawn    Create a plan deck that researches and writes a plan (no code changes)
#   approve  Mark a plan as approved (status: ready → approved)
#   execute  Create an exec deck that implements the approved plan
#   status   Print current plan status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ACTION=""
NAME=""
DIR=""
TASK=""

# Parse subcommand first, then flags
if [[ $# -gt 0 ]]; then
  case "$1" in
    spawn|execute|status|approve) ACTION="$1"; shift ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --dir)  DIR="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  echo "Usage: booth-plan.sh <spawn|approve|execute|status> --name <name> --dir <dir> [--task <desc>]" >&2
  exit 1
fi

if [[ -z "$NAME" || -z "$DIR" ]]; then
  echo "Error: --name and --dir are required" >&2
  exit 1
fi

# Resolve DIR to absolute path
DIR="$(cd "$DIR" && pwd)"

# Ensure .booth/plans/ exists
PLANS_DIR="$DIR/.booth/plans"
mkdir -p "$PLANS_DIR"

case "$ACTION" in
  spawn)
    if [[ -z "$TASK" ]]; then
      echo "Error: --task is required for spawn" >&2
      exit 1
    fi

    # Check if plan already exists
    if [[ -f "$PLANS_DIR/${NAME}.md" ]]; then
      echo "Error: plan '$NAME' already exists at $PLANS_DIR/${NAME}.md" >&2
      exit 1
    fi

    # Create status file
    echo "planning" > "$PLANS_DIR/${NAME}.status"

    # Create meta.json
    cat > "$PLANS_DIR/${NAME}.meta.json" <<METAEOF
{
  "planDeck": "plan-${NAME}",
  "execDeck": "",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "task": $(printf '%s' "$TASK" | jq -Rs .)
}
METAEOF

    # Write plan deck system prompt to file (avoids shell escaping issues)
    PROMPT_FILE="$PLANS_DIR/${NAME}.system-prompt"
    cat > "$PROMPT_FILE" <<'SYSEOF'
You are a **planning deck**. Your job is to research the codebase and produce a detailed implementation plan. You must NOT implement any changes.

## Rules

1. Research thoroughly — use Read, Grep, Glob, WebSearch, WebFetch, Task (subagents), LSP
2. Do NOT modify any source code files
3. Do NOT use Edit or NotebookEdit (they are blocked)
4. Bash is for READ-ONLY commands only (ls, git log, git diff, etc.)
5. When your plan is complete, write it using Write tool to the plan file path shown below
6. Then write "ready" to the status file path shown below
7. Include `[PLAN READY]` in your final message
SYSEOF

    # Append plan-specific paths
    cat >> "$PROMPT_FILE" <<PATHEOF

## Paths

- Plan file: .booth/plans/${NAME}.md
- Status file: .booth/plans/${NAME}.status

## Plan Format

Write .booth/plans/${NAME}.md with this structure:

\`\`\`markdown
# Plan: ${NAME}

## Goal
<what we're trying to achieve>

## Research Summary
<key findings from codebase research>

## Implementation Steps
1. <step description> — <file(s) affected>
2. ...

## Files Affected
- path/to/file — what changes and why

## Risks / Open Questions
- ...

## Testing Strategy
- how to verify the changes work
\`\`\`
PATHEOF

    # Spawn plan deck with restricted tools (Edit and NotebookEdit blocked)
    "$SCRIPT_DIR/spawn-child.sh" \
      --name "plan-${NAME}" \
      --dir "$DIR" \
      --system-prompt-file "$PROMPT_FILE" \
      --disallowed-tools "Edit,NotebookEdit" \
      --prompt "Research and create a plan for: ${TASK}. Write the plan to .booth/plans/${NAME}.md. When done, write 'ready' to .booth/plans/${NAME}.status and include [PLAN READY] in your message."

    echo "plan=$NAME"
    echo "status=planning"
    echo "deck=plan-${NAME}"
    ;;

  approve)
    STATUS_FILE="$PLANS_DIR/${NAME}.status"
    if [[ ! -f "$STATUS_FILE" ]]; then
      echo "Error: no status file for plan '$NAME'" >&2
      exit 1
    fi

    CURRENT=$(cat "$STATUS_FILE")
    if [[ "$CURRENT" != "ready" ]]; then
      echo "Error: plan status is '$CURRENT', expected 'ready'" >&2
      exit 1
    fi

    echo "approved" > "$STATUS_FILE"
    echo "plan=$NAME"
    echo "status=approved"
    ;;

  execute)
    # Verify plan exists and is approved
    if [[ ! -f "$PLANS_DIR/${NAME}.md" ]]; then
      echo "Error: plan file not found: $PLANS_DIR/${NAME}.md" >&2
      exit 1
    fi

    STATUS_FILE="$PLANS_DIR/${NAME}.status"
    if [[ -f "$STATUS_FILE" ]]; then
      CURRENT=$(cat "$STATUS_FILE")
      if [[ "$CURRENT" != "approved" ]]; then
        echo "Error: plan status is '$CURRENT', expected 'approved'" >&2
        exit 1
      fi
    fi

    # Update status
    echo "executing" > "$STATUS_FILE"

    # Update meta.json with exec deck name
    META_FILE="$PLANS_DIR/${NAME}.meta.json"
    if [[ -f "$META_FILE" ]] && command -v jq &>/dev/null; then
      TMP=$(mktemp)
      jq --arg deck "exec-${NAME}" '.execDeck = $deck' "$META_FILE" > "$TMP" && mv "$TMP" "$META_FILE"
    fi

    # Write exec deck system prompt
    PROMPT_FILE="$PLANS_DIR/${NAME}.exec-system-prompt"
    cat > "$PROMPT_FILE" <<EXECEOF
You are an **execution deck**. Implement the plan at .booth/plans/${NAME}.md exactly as specified.

## Rules

1. Read .booth/plans/${NAME}.md first — understand every step before writing code
2. Implement each step in order
3. Test your changes (run tests, verify behavior)
4. Commit your changes with a descriptive message when done
5. Write "done" to .booth/plans/${NAME}.status
6. Include [PLAN DONE] in your final message

## Paths

- Plan file: .booth/plans/${NAME}.md
- Status file: .booth/plans/${NAME}.status
EXECEOF

    # Spawn exec deck with full tool access
    "$SCRIPT_DIR/spawn-child.sh" \
      --name "exec-${NAME}" \
      --dir "$DIR" \
      --system-prompt-file "$PROMPT_FILE" \
      --prompt "Execute the plan at .booth/plans/${NAME}.md — read it first, then implement step by step. When done, write 'done' to .booth/plans/${NAME}.status and include [PLAN DONE] in your message."

    echo "plan=$NAME"
    echo "status=executing"
    echo "deck=exec-${NAME}"
    ;;

  status)
    STATUS_FILE="$PLANS_DIR/${NAME}.status"
    if [[ -f "$STATUS_FILE" ]]; then
      STATUS=$(cat "$STATUS_FILE")
      echo "plan=$NAME"
      echo "status=$STATUS"

      # Show meta if available
      META_FILE="$PLANS_DIR/${NAME}.meta.json"
      if [[ -f "$META_FILE" ]]; then
        echo "meta=$(cat "$META_FILE")"
      fi

      # Show plan existence
      if [[ -f "$PLANS_DIR/${NAME}.md" ]]; then
        echo "plan_file=$PLANS_DIR/${NAME}.md"
      fi
    else
      echo "plan=$NAME"
      echo "status=not-found"
    fi
    ;;
esac
