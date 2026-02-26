#!/bin/bash
# detect-state.sh — Detect the state of a child Claude Code session from pane output
#
# Usage: echo "<pane-output>" | detect-state.sh
#
# Output: working | idle | waiting-approval | needs-attention | collapsed | unknown
#
# Uses dual-signal detection: primary pattern must match, and for some states
# a secondary signal must also confirm.

set -euo pipefail

INPUT=$(cat)

if [[ -z "$INPUT" ]]; then
  echo "unknown"
  exit 0
fi

# Get last non-empty line
LAST_LINE=$(echo "$INPUT" | grep -v '^[[:space:]]*$' | tail -1 || true)

# --- SPECIAL: collapsed transcript ---
if echo "$INPUT" | grep -q "Showing detailed transcript" && \
   echo "$INPUT" | grep -qE '· [A-Z][a-zA-Z]+\(' ; then
  echo "collapsed"
  exit 0
fi

# --- PRIMARY: [NEEDS ATTENTION] marker ---
if echo "$INPUT" | grep -qF "[NEEDS ATTENTION]"; then
  echo "needs-attention"
  exit 0
fi

# --- PRIMARY: Allow/Deny approval prompt ---
# Claude Code shows Allow/Deny when requesting tool permission
HAS_ALLOW_DENY=false
if echo "$INPUT" | grep -qE '(Allow|Deny)' && \
   echo "$INPUT" | grep -qE '(Allow|Deny).*\b(Allow|Deny)\b'; then
  HAS_ALLOW_DENY=true
fi

# Also check for numbered options pattern (alternative approval format)
HAS_NUMBERED_OPTIONS=false
if echo "$INPUT" | grep -qE '^\s*1\.' && \
   echo "$INPUT" | grep -qE '^\s*2\.'; then
  HAS_NUMBERED_OPTIONS=true
fi

# SECONDARY: tool keywords that confirm it's a real approval prompt
HAS_TOOL_KEYWORD=false
TOOL_PATTERN='(Bash|Write|Edit|Read|Glob|Grep|WebFetch|WebSearch|Task|NotebookEdit|LSP)'
if echo "$INPUT" | grep -qE "$TOOL_PATTERN"; then
  HAS_TOOL_KEYWORD=true
fi

# Secondary: permission-related phrases
HAS_PERMISSION_PHRASE=false
if echo "$INPUT" | grep -qiE '(want to proceed|permission|approve|allow once|allow always)'; then
  HAS_PERMISSION_PHRASE=true
fi

# Dual-signal: waiting-approval requires primary + secondary
if [[ "$HAS_ALLOW_DENY" == true || "$HAS_NUMBERED_OPTIONS" == true ]]; then
  if [[ "$HAS_TOOL_KEYWORD" == true || "$HAS_PERMISSION_PHRASE" == true ]]; then
    echo "waiting-approval"
    exit 0
  fi
fi

# --- PRIMARY: idle — prompt symbol at last line ---
if echo "$LAST_LINE" | grep -qE '^\s*[>$%]\s*$'; then
  echo "idle"
  exit 0
fi

# Also check for claude's specific prompt format (with project path)
if echo "$LAST_LINE" | grep -qE '>\s*$'; then
  echo "idle"
  exit 0
fi

# --- PRIMARY: working — if there's content and none of the above matched ---
# Check if there's meaningful content (not just empty lines)
CONTENT_LINES=$(echo "$INPUT" | grep -cv '^[[:space:]]*$' || true)
if [[ "$CONTENT_LINES" -gt 2 ]]; then
  echo "working"
  exit 0
fi

echo "unknown"
