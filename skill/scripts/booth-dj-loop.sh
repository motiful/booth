#!/usr/bin/env bash
# booth-dj-loop.sh — Run DJ claude in a restart loop with --resume support
#
# First launch: claude --append-system-prompt "..."
# Subsequent restarts: claude --resume <id> (extracted from pane output)
# Ctrl-C during the 3s sleep breaks the loop.
#
# Usage: booth-dj-loop.sh <socket-name> <system-prompt>

set -uo pipefail

SOCKET="${1:?Usage: booth-dj-loop.sh <socket> <prompt>}"
PROMPT="${2:-}"
RESUME_ID=""

while true; do
  if [[ -n "$RESUME_ID" ]]; then
    echo "[booth] Resuming DJ (session: ${RESUME_ID:0:8}…)"
    claude --resume "$RESUME_ID"
  elif [[ -n "$PROMPT" ]]; then
    claude --append-system-prompt "$PROMPT"
  else
    claude
  fi

  # Extract resume ID from pane output after claude exits
  RESUME_ID=""
  PANE_OUTPUT=$(tmux -L "$SOCKET" capture-pane -p -S -20 2>/dev/null || true)
  if [[ -n "$PANE_OUTPUT" ]]; then
    RESUME_ID=$(echo "$PANE_OUTPUT" | grep -oE -- '--resume [0-9a-f-]+' | tail -1 | awk '{print $2}')
  fi

  if [[ -n "$RESUME_ID" ]]; then
    echo "[booth] DJ exited. Will resume (${RESUME_ID:0:8}…) in 3s — Ctrl-C to stop"
  else
    echo "[booth] DJ exited. Restarting fresh in 3s — Ctrl-C to stop"
  fi
  sleep 3
done
