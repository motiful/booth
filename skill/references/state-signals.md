# State Signal Patterns

Complete pattern matching rules for `detect-state.sh`.

## Signal Types

### PRIMARY signals (first-pass detection)

#### waiting-approval
Claude Code requests tool permission in several formats:

**Style A — Inline Allow/Deny:**
```
  Allow   Deny    Bash(npm test)
```

**Style B — Block format:**
```
╭──────────────────────╮
│ Allow   Deny         │
│ Bash(git status)     │
╰──────────────────────╯
```

**Style C — Numbered options:**
```
1. Allow once
2. Allow always
3. Deny
```

Primary pattern: `Allow` AND `Deny` on same or adjacent lines, OR numbered options `1.` + `2.`

#### needs-attention
Our custom marker injected by child protocol:
```
[NEEDS ATTENTION] description of the issue...
```
Primary pattern: literal `[NEEDS ATTENTION]`

#### idle
Claude Code prompt indicator at last non-empty line:
```
>
$
%
```
Primary pattern: last line matches `^\s*[>$%]\s*$`

Also matches Claude's path-prefixed prompt:
```
~/projects/app >
```
Pattern: line ending with `>\s*$`

#### working
Content is changing but doesn't match any of the above patterns.
Detected by: `poll-child.sh` reports `changed` but no other state matches.

#### collapsed
Claude Code sometimes collapses long tool outputs:
```
Showing detailed transcript (press Ctrl+O to expand)
  · Bash(npm test)
  · Read(src/index.ts)
  · Edit(src/app.ts)
```
Primary pattern: `Showing detailed transcript` AND `· ToolName(`

### SECONDARY signals (confirm primary)

#### Tool keywords
Confirm `waiting-approval` when seen near Allow/Deny:
- `Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`
- `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`, `LSP`
- Format: `ToolName(...)` or just `ToolName`

#### Permission phrases
Confirm `waiting-approval`:
- `want to proceed`
- `permission`
- `approve`
- `allow once`
- `allow always`

## Detection Rules

```
IF [NEEDS ATTENTION] found        → needs-attention  (primary only)
IF collapsed transcript detected  → collapsed         (primary only)
IF Allow+Deny AND tool keyword    → waiting-approval  (primary + secondary)
IF Allow+Deny AND permission phrase → waiting-approval (primary + secondary)
IF numbered options AND tool keyword → waiting-approval (primary + secondary)
IF last line is prompt symbol     → idle              (primary only)
IF content exists and changed     → working           (fallback)
ELSE                              → unknown
```

## False Positive Prevention

- Allow/Deny without tool keywords → NOT waiting-approval (could be user text)
- Numbered options without tool context → NOT waiting-approval (could be CC presenting choices)
- Single `>` in middle of output → NOT idle (only last line counts)
- Empty output → unknown, not idle

## Actions per State

| State | Action |
|-------|--------|
| working | No action, adjust poll interval |
| idle | Read output, report to user |
| waiting-approval | Send Enter to approve (or notify user) |
| needs-attention | Read full output (--lines 100+), present to user |
| collapsed | Send Ctrl+O (`tmux send-keys -t <name> C-o`), re-poll |
| unknown | Retry with --lines 100, if still unknown → notify user |
