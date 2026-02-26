#!/usr/bin/env bash
# booth-stop-hook.sh — CC stop hook that surfaces deck alerts (Layer 3)
#
# Installed as a CC stop hook. Runs after each DJ turn ends.
# Reads .booth/alerts.json, outputs unread alerts as system context,
# then clears the file. CC injects stdout into the next turn.
#
# Only activates for the DJ session (checks tmux session name).
# Safe no-op for non-Booth sessions (no .booth/ → exits silently).

set -euo pipefail

# Only run if .booth/ exists (we're in a Booth project)
ALERTS_FILE=".booth/alerts.json"
[[ -d ".booth" ]] || exit 0
[[ -f "$ALERTS_FILE" ]] || exit 0

# Only run for the DJ session
# Check if we're in a tmux session named "dj" (or the configured DJ name)
SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || true)
if [[ -z "$SESSION_NAME" ]]; then
  exit 0
fi

# Read the DJ session name from tmux user variable, fallback to "dj"
SOCK=$(tmux display-message -p '#{socket_path}' 2>/dev/null || true)
if [[ -n "$SOCK" ]]; then
  DJ_NAME=$(tmux -S "$SOCK" show -gvq @booth-dj 2>/dev/null || echo "dj")
else
  DJ_NAME="dj"
fi

if [[ "$SESSION_NAME" != "$DJ_NAME" ]]; then
  exit 0
fi

# Read alerts — atomic: read + clear in one operation
# Use python3 for safe JSON handling + atomic file swap
ALERTS=$(python3 -c "
import json, sys, os

f = sys.argv[1]
try:
    with open(f) as fh:
        alerts = json.load(fh)
except (FileNotFoundError, json.JSONDecodeError):
    sys.exit(0)

if not alerts:
    sys.exit(0)

# Clear the file (atomic write)
tmp = f + '.tmp'
with open(tmp, 'w') as fh:
    json.dump([], fh)
    fh.write('\n')
os.replace(tmp, f)

# Output alerts for CC
for a in alerts:
    ts = a.get('timestamp', '?')[:19]
    deck = a.get('deck', '?')
    atype = a.get('type', '?')
    msg = a.get('message', '')
    print(f'[booth-alert] [{atype}] {deck}: {msg} (at {ts})')
" "$ALERTS_FILE" 2>/dev/null) || true

if [[ -n "$ALERTS" ]]; then
  echo "$ALERTS"
fi
