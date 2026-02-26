# Adaptive Polling Strategy

Booth uses adaptive polling to monitor decks — not fixed intervals.

## Per-deck Poll Flow

```
1. poll-child.sh <name> --prev-hash <last-hash>
   ├── unchanged → skip, extend interval
   └── changed → pipe to detect-state.sh
       ├── working → no action, keep interval
       ├── idle → read output, report to user
       ├── waiting-approval → send Enter to approve
       ├── needs-attention → read full output, present to user
       ├── collapsed → send Ctrl+O, re-poll
       └── unknown → retry with --lines 100
```

## How to Poll (Bash)

```bash
# Basic poll
RESULT=$(~/.claude/skills/booth/scripts/poll-child.sh "deck-name" --prev-hash "$PREV_HASH")

# Parse result
STATUS=$(echo "$RESULT" | cut -f1)
HASH=$(echo "$RESULT" | cut -f2)
TEXT=$(echo "$RESULT" | cut -f3-)

# If changed, detect state
if [ "$STATUS" = "changed" ]; then
  STATE=$(echo "$TEXT" | ~/.claude/skills/booth/scripts/detect-state.sh)
fi
```

## Interval Rules

| State | Next Poll | Rationale |
|-------|-----------|-----------|
| Just spawned | 30s | Child starting up, give it time |
| Working (hash changing) | 15-20s | Active work, moderate check-ins |
| Hash stopped changing | 10s | Possibly finished, increase frequency |
| Idle (waiting for input) | Immediate | Booth decides next step |
| waiting-approval | Immediate | Auto-approve or notify user |
| needs-attention | Immediate | Read details, present to user |
| collapsed | Immediate | Send Ctrl+O to expand, re-detect |

## Multi-deck Round-robin

When multiple decks are running:
- Poll them in round-robin order
- Stagger polls so total cycle stays under 30s
- Prioritize decks with recent state changes
- If any deck enters `needs-attention` or `waiting-approval`, handle it immediately before continuing the round

## What to Tell the User

- On state change: brief status update ("api-refactor is still working" / "research-auth finished")
- On needs-attention: full details + what the deck is asking
- On idle: summary of what the deck accomplished
- Don't spam — only report meaningful changes

---

## Dual-Channel Monitoring: JSONL + capture-pane

`poll-child.sh` supports two signal sources. JSONL is more precise; capture-pane is the universal fallback.

### Priority

```
1. If decks.json has sessionJsonlPath → use jsonl-monitor.sh (precise)
2. If JSONL unavailable or inconclusive → fallback to capture-pane (universal)
3. If both signals conflict → JSONL wins (it's structured data vs screen scraping)
```

### When capture-pane is still needed

- **waiting-approval**: JSONL doesn't record Allow/Deny UI events (they're terminal-layer, not API-layer)
- **Legacy sessions**: decks started before JSONL tracking, or manually started decks without sessionJsonlPath
- **JSONL path unknown**: if Booth couldn't discover the JSONL path at spawn time

### Session JSONL Path Discovery

CC stores session transcripts at:
```
~/.claude/projects/<url-encoded-project-path>/<session-uuid>.jsonl
```

**At spawn time**, Booth discovers the JSONL path:
1. URL-encode the deck's working directory path (replace `/` with `-`, prepend `-`)
2. List `~/.claude/projects/<encoded>/` directory
3. Find the newest `.jsonl` file created after spawn (within a few seconds)
4. Write the path to `decks.json` → `sessionJsonlPath`

If discovery fails (directory doesn't exist yet, timing race), leave `sessionJsonlPath` empty — poll-child.sh will use capture-pane only.
