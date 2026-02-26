#!/bin/bash
# DEPRECATED: Use deck-status.sh or jsonl-state.py instead.
# This script is superseded by the unified jsonl-state.py parser.
#
# jsonl-monitor.sh — Detect CC session state from JSONL transcript
#
# Usage: jsonl-monitor.sh <jsonl-path>
#
# Output: working | idle | needs-attention | unknown
#
# Reads the tail of a CC session JSONL file and determines the session's
# current state based on the last events.
#
# This is a SUPPLEMENTARY signal source — it does NOT detect waiting-approval
# (Allow/Deny is a terminal UI event, not recorded in JSONL).
# Use capture-pane via detect-state.sh for that.
#
# CC JSONL format:
#   - Each line is a JSON object with "type" field: user, assistant, progress, system, etc.
#   - assistant messages have message.content[] with types: text, thinking, tool_use
#   - message.stop_reason: null (streaming/partial), "stop_sequence" (turn complete)
#   - tool_use in content means model wants to run a tool → working
#   - stop_sequence with text-only content → idle

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Error: usage: jsonl-monitor.sh <jsonl-path>" >&2
  exit 1
fi

JSONL_PATH="$1"

# Expand ~ to $HOME
JSONL_PATH="${JSONL_PATH/#\~/$HOME}"

if [[ ! -f "$JSONL_PATH" ]]; then
  echo "unknown"
  exit 0
fi

# Use python3 for reliable JSON parsing (available on macOS)
BOOTH_JSONL_PATH="$JSONL_PATH" python3 << 'PYEOF'
import json, sys, os

fpath = os.environ["BOOTH_JSONL_PATH"]

try:
    # Read last 100 lines — enough context for state detection
    import subprocess
    tail = subprocess.run(["tail", "-100", fpath], capture_output=True, text=True)
    lines = tail.stdout.strip().split("\n")
except Exception:
    print("unknown")
    sys.exit(0)

if not lines or lines == ['']:
    print("unknown")
    sys.exit(0)

# Parse all lines into events
events = []
for line in lines:
    try:
        events.append(json.loads(line))
    except:
        pass

if not events:
    print("unknown")
    sys.exit(0)

# Check file staleness FIRST — if JSONL hasn't been written to in >120s,
# the CC process is not actively working regardless of what the last event says.
# A dead/suspended session's JSONL just stops being written to.
import time
mtime = os.path.getmtime(fpath)
file_age = time.time() - mtime

if file_age > 120:
    # File is stale. Check if it ended cleanly or not.
    last_type = None
    for ev in reversed(events):
        t = ev.get("type")
        if t in ("assistant", "user"):
            last_type = t
            break
    if last_type == "assistant":
        msg_ev = next((e for e in reversed(events) if e.get("type") == "assistant"), {})
        sr = msg_ev.get("message", {}).get("stop_reason")
        if sr == "stop_sequence":
            print("idle")
        else:
            print("idle")  # Stale + no clear stop → assume idle/dead
    else:
        print("idle")  # Stale file, user was last to speak → session died
    sys.exit(0)

# Check for recent API errors (in last 5 events)
for ev in events[-5:]:
    if ev.get("type") == "progress":
        data = ev.get("data", {})
        if isinstance(data, dict) and "error" in str(data).lower():
            print("needs-attention")
            sys.exit(0)

# Find the last meaningful event (assistant or user)
last_assistant = None
last_user = None
last_event_type = None

for ev in reversed(events):
    t = ev.get("type")
    if t == "assistant" and last_assistant is None:
        last_assistant = ev
        if last_event_type is None:
            last_event_type = "assistant"
    elif t == "user" and last_user is None:
        last_user = ev
        if last_event_type is None:
            last_event_type = "user"
    if last_assistant and last_user:
        break

if last_event_type is None:
    print("unknown")
    sys.exit(0)

# If the last event is a user message → model is processing → working
# (user message could be human input or tool_result)
if last_event_type == "user":
    print("working")
    sys.exit(0)

# Last event is assistant — analyze it
if last_assistant:
    msg = last_assistant.get("message", {})
    content = msg.get("content", [])
    stop_reason = msg.get("stop_reason")

    # Check content types
    content_types = set()
    for c in content:
        if isinstance(c, dict):
            content_types.add(c.get("type", ""))

    # tool_use in content → model wants to execute a tool → working
    if "tool_use" in content_types:
        print("working")
        sys.exit(0)

    # stop_sequence with text content → turn complete → idle
    if stop_reason == "stop_sequence":
        print("idle")
        sys.exit(0)

    # stop_reason is None, file is fresh (<120s) → likely streaming
    if file_age < 10:
        print("working")
    elif file_age < 60:
        print("working")
    else:
        print("idle")
    sys.exit(0)

print("unknown")
PYEOF
