# Adaptive Polling Strategy

Booth uses adaptive polling to monitor decks — not fixed intervals.

## Per-deck Poll Flow

```
1. poll-child.sh <name> --prev-hash <last-hash>
   ├── unchanged → skip, extend interval
   └── changed → deck-status.sh detects state (JSONL primary, capture-pane fallback)
       ├── working → no action, keep interval
       ├── idle → read output, report to user
       ├── waiting-approval → send Enter to approve
       ├── needs-attention → read full output, present to user
       ├── error → check details, retry or escalate
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

# State is also available via stderr (state=<value>)
# Or query directly:
STATE=$(~/.claude/skills/booth/scripts/deck-status.sh "deck-name")
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

## Detection: JSONL Primary, capture-pane Fallback

All state detection goes through `deck-status.sh` which calls `jsonl-state.py`:

```
1. Find deck's JSONL: tmux CWD → encode path → ~/.claude/projects/<encoded>/*.jsonl
2. Parse last 50 JSONL lines → determine state
3. If JSONL says idle/unknown → check capture-pane for Allow/Deny (waiting-approval)
4. If no JSONL found → full fallback to capture-pane + detect-state.sh
```

### Session JSONL Path Discovery

CC stores session transcripts at:
```
~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
```

Path encoding: replace `/` and `.` with `-`. Example:
```
/Users/foo/bar/.baz → -Users-foo-bar--baz
```

`deck-status.sh` discovers the path automatically from the deck's tmux CWD. No need to store in `decks.json` (though `sessionJsonlPath` is still accepted if present).

### When capture-pane is still needed

- **waiting-approval**: JSONL doesn't record Allow/Deny UI events (terminal-layer, not API-layer)
- **Legacy/manual sessions**: no JSONL available
- **New deck**: JSONL not yet created (CC still starting up)
