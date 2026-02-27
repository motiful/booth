#!/bin/bash
# dj-statusline.sh — CC statusline script for Booth DJ
#
# CC pipes session JSON to stdin on each assistant message.
# This script:
#   1. Extracts context_window.used_percentage
#   2. Writes it to .booth/dj-context.json (for watchdog to read)
#   3. Outputs a statusline string for display

input=$(cat)

PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null | cut -d. -f1)
CWD=$(echo "$input" | jq -r '.cwd // ""' 2>/dev/null)

# Write context state to .booth/dj-context.json (atomic write)
if [[ -n "$CWD" && -d "$CWD/.booth" ]]; then
  TMP="$CWD/.booth/dj-context.json.tmp"
  TARGET="$CWD/.booth/dj-context.json"
  printf '{"used_percentage":%d,"timestamp":"%s"}\n' \
    "${PCT:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP"
  mv "$TMP" "$TARGET"
fi

# Output statusline
echo "ctx:${PCT:-0}%"
