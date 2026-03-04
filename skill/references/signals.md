# Signals Reference

## Signal Architecture

```
JSONL events → Signal module → State module → Reactor → notifyDj → DJ
```

Every deck has a JSONL stream. The daemon tails it in real-time.

## Authoritative Signals

| State | Signal | Source |
|-------|--------|--------|
| working | `type=user` or `assistant(tool_use/thinking)` or `progress` | JSONL |
| idle | `subtype=turn_duration` | JSONL |
| error | `subtype=api_error` | JSONL |
| needs-attention | `[NEEDS ATTENTION]` in assistant text | JSONL |
| stopped | Pane detected dead during health check, or CC session self-exited (SessionEnd hook) | Daemon (internal) |

### Design rules

- One authoritative signal per state
- No multi-signal cross-validation
- No debounce needed (turn_duration is definitive)
- capture-pane is debug only, never for core detection

## Alert Scenarios

All alerts are delivered as `[booth-alert] <natural language description>`. There are no structured type identifiers — DJ parses the description text to determine the scenario.

| Scenario | Trigger | Action |
|----------|---------|--------|
| Check complete | Deck idle + report has terminal status | DJ: read report, deliver or retry |
| Error | Error persists beyond 30s recovery window | DJ: spin review deck or escalate to user |
| Needs attention | Deck flagged `[NEEDS ATTENTION]` | DJ: check what it needs |
| Deck exited | CC session self-exited (via SessionEnd hook) | DJ: read exit report, decide re-spin or acknowledge |

### Error Recovery Window

Deck errors have a 30-second recovery window before alerting DJ:

1. Error detected (API error, pane issue)
2. Start 30s timer
3. If deck emits a `working` event within 30s → error silently absorbed, no alert
4. If 30s elapses with no recovery → alert DJ with context ("during check" or "during work")

This prevents transient errors (rate limits, network blips) from triggering unnecessary escalation.

### Idle + Check Flow (Mode-Dependent)

When daemon detects deck idle, behavior depends on mode:

**Auto mode** (default):
1. Check if `.booth/reports/<deck>.md` exists
2. **No report** → send `[booth-check]` to deck (triggers self-verification)
3. **Report exists with terminal status** → notify DJ → DJ reads report → kill deck

**Hold mode**:
1. Same check flow as auto
2. **Report exists with terminal status** → notify DJ → deck **pauses** (waits for next instruction)
3. DJ can give the deck a new task or kill it

**Live mode**:
1. Idle detected → **nothing happens** (no auto check)
2. Deck stays idle until the human interacts or DJ switches mode

`[booth-check]` is idempotent — safe to resend after compaction or any interruption.

### Mode Switching and Idle

When a deck's mode is switched to auto or hold while it is idle, the daemon immediately triggers the check flow (same as if idle was just detected). In-flight checks are not interrupted by mode switches.

### Plan Mode Auto-Approve (Mode-Dependent)

CC may enter plan mode (`EnterPlanMode` tool_use) during complex tasks, self-restricting to read-only and blocking execution.

**Detection**: JSONL `assistant` messages with `tool_use` blocks named `EnterPlanMode` or `ExitPlanMode`.

**Response by mode**:

| Mode | On EnterPlanMode | On ExitPlanMode |
|------|-----------------|-----------------|
| **Auto** | Log warning | Start 3s timer → send Enter to approve |
| **Hold** | Log warning | Start 3s timer → send Enter to approve |
| **Live** | Log only (ignored) | Log only (ignored) |

The 3s delay allows `--dangerously-skip-permissions` to auto-resolve if possible. If the deck emits a `working` event within 3s (meaning it moved on), the timer is canceled. Enter is only sent if the deck appears stuck at the approval UI.

## Injected Signals

| Signal | Target | When |
|--------|--------|------|
| `[booth-alert]` | DJ | Deck state change (idle with report, error, needs-attention) |
| `[booth-check]` | Deck | Deck idle, no report file yet |
| `[booth-beat]` | DJ | Timer: DJ idle + decks working + cooldown elapsed |

## Alert Delivery

Alerts reach DJ through direct injection. The reactor calls `notifyDj(message)` which uses `protectedSendToCC` — a Ctrl+G editor proxy mechanism that preserves any user input in the DJ pane.

If DJ is idle, the alert is injected and submitted immediately. If DJ is working, CC's message queuing handles it (the alert may interrupt or queue). If DJ is in Ctrl+G editor mode, the injection waits until the user closes the editor.

The beat mechanism serves as a periodic fallback — even if an individual alert is lost, the next beat summarizes all deck statuses.

### Check signal format

```
[booth-check] Read /absolute/path/to/.booth/check.md and follow the self-verification procedure. Your report path: /absolute/path/to/.booth/reports/<deck>.md
```

Paths are absolute (resolved from the project root). If `.booth/check.md` does not exist, a fallback message is sent instead:

```
[booth-check] Self-verify your work. Write report to: /absolute/path/to/.booth/reports/<deck>.md with YAML frontmatter `status: SUCCESS` or `status: FAIL`.
```

If the deck was spun with `--no-loop`, an additional suffix is appended: `Skip the sub-agent review loop. Write your report directly.`

## Terminal Report Statuses

| Status | Meaning |
|--------|---------|
| `SUCCESS` | Task completed and passed self-check |
| `FAIL` / `FAILED` | Task completed but failed self-check |
| `ERROR` | Abnormal crash during execution |
| `EXIT` | CC session self-exited (user `/exit`, timeout, crash) |

## SessionEnd Hook — Deck Exit Detection

When a deck's CC session exits on its own (`/exit`, crash, timeout), the CC `SessionEnd` hook fires instantly — no need to wait for the 30s health check.

### Data Flow

```
CC exits → SessionEnd hook → bash wrapper → Node.js handler
→ read stdin JSON {session_id, transcript_path, cwd, reason}
→ read .booth/state.json → match deck by jsonlPath
→ if DJ session: exit silently (no report, no IPC)
→ if deck: write EXIT report to .booth/reports/<deck>.md
→ IPC 'deck-exited' → daemon cleanup → notifyDj()
```

### Behavior

- Deck is marked `stopped` (not removed) — stays visible in `booth ls`
- Exit report includes the last user-assistant exchange from the JSONL tail
- If daemon is unreachable, report is still written to disk — health check serves as fallback
- DJ exit (`/exit` in DJ pane) is silently ignored — no report generated
