#!/bin/bash
# booth-watchdog.sh — Persistent JSONL-based monitor for Booth decks
#
# Runs in a hidden tmux window inside the DJ session ("_watchdog" window).
# Uses tail -f on each deck's CC session JSONL for event-driven detection.
#
# Architecture:
#   - Per-deck watcher: tail -f <jsonl> → Python parser detects state transitions
#   - Management loop: periodically checks decks.json for new/removed decks
#   - Alerts DJ only on state transitions (not every event)
#   - 60s idle timeout: working deck with no events → idle
#   - Auto-exits when no active decks remain or DJ session dies
#
# Started by spawn-child.sh; guarded by booth-heartbeat.sh (cron).
# Core logic in jsonl-state.py (shared with deck-status.sh).

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL_STATE_PY="$SCRIPT_DIR/jsonl-state.py"

if [[ ! -f "$JSONL_STATE_PY" ]]; then
  echo "[watchdog] ERROR: jsonl-state.py not found at $JSONL_STATE_PY" >&2
  exit 1
fi

# Pass env vars through and exec into Python watchdog mode
exec python3 "$JSONL_STATE_PY" watchdog
