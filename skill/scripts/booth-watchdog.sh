#!/bin/bash
# booth-watchdog.sh — Persistent JSONL-based monitor for Booth decks
#
# Uses tail -f on each deck's CC session JSONL for event-driven detection.
#
# Architecture:
#   - Per-deck watcher: tail -f <jsonl> → Node.js parser detects state transitions
#   - Management loop: periodically checks decks.json for new/removed decks
#   - Writes alerts to .booth/alerts.json (Layer 2) on state transitions
#   - 60s idle timeout: working deck with no events → idle
#   - Auto-exits when no active decks remain or DJ session dies
#   - Auto-restarts when jsonl-state.mjs is updated (exit code 42)
#
# Started by spawn-child.sh; guarded by booth-guardian.sh (cron).
# Core logic in jsonl-state.mjs (shared with deck-status.sh).

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL_STATE="$SCRIPT_DIR/jsonl-state.mjs"

if [[ ! -f "$JSONL_STATE" ]]; then
  echo "[watchdog] ERROR: jsonl-state.mjs not found at $JSONL_STATE" >&2
  exit 1
fi

# Restart loop: exit code 42 = code updated, restart automatically
while true; do
  node "$JSONL_STATE" watchdog || EXIT_CODE=$?
  EXIT_CODE=${EXIT_CODE:-0}
  if [[ $EXIT_CODE -eq 42 ]]; then
    echo "[watchdog] Code updated, restarting in 1s..."
    sleep 1
    EXIT_CODE=0
    continue
  fi
  exit $EXIT_CODE
done
