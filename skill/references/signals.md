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
| idle | `subtype=turn_duration` or `subtype=stop_hook_summary` or `type=last-prompt` | JSONL |
| checking | Set by reactor when sending `[booth-check]` | Daemon (internal) |
| exited | CC session self-exited (SessionEnd hook) or `booth kill` | Daemon (internal) |

### Design rules

- One authoritative signal per state
- No multi-signal cross-validation
- No debounce needed (idle signals are definitive; state deduplicates repeated idle)
- capture-pane is debug only, never for core detection
- Shutdown does NOT change deck status — decks stay working/idle in DB for resume
- Records persist forever — `booth kill` marks exited (UPDATE), never deletes DB rows
- Clean shutdown (`--clean`) marks all decks exited — they won't auto-resume but can be manually resumed

## Alert Scenarios

All alerts are delivered as `[booth-alert] <natural language description>`. There are no structured type identifiers — DJ parses the description text to determine the scenario.

| Scenario | Trigger | Action |
|----------|---------|--------|
| Check complete | Deck idle + report has terminal status | DJ: read report, deliver or retry |
| Deck exited | CC session self-exited (via SessionEnd hook) | DJ: read exit report, decide re-spin or acknowledge |

### Idle + Check Flow (Mode-Dependent)

When daemon detects deck idle, behavior depends on mode:

**Auto mode** (default):
1. Check DB for terminal report
2. **No report** → send `[booth-check]` to deck (triggers self-verification)
3. **Report submitted via `booth report` CLI** → daemon receives via IPC → notify DJ → kill deck

**Hold mode**:
1. Same check flow as auto
2. **Report submitted with terminal status** → notify DJ → deck **pauses** (waits for next instruction)
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
| `[booth-alert]` | DJ | Deck state change (idle with report, deck exited) |
| `[booth-check]` | Deck | Deck idle, no terminal report in DB |
| `[booth-beat]` | DJ | Timer: active decks exist + cooldown elapsed (fires regardless of DJ status) |

## Alert Delivery

Alerts reach DJ through direct injection. The reactor calls `notifyDj(message)` which uses `protectedSendToCC` — a Ctrl+G editor proxy mechanism that preserves any user input in the DJ pane.

If DJ is idle, the alert is injected and submitted immediately. If DJ is working, CC's message queuing handles it (the alert may interrupt or queue). If DJ is in Ctrl+G editor mode, the injection waits until the user closes the editor.

The beat mechanism serves as a periodic fallback — even if an individual alert is lost, the next beat summarizes all deck statuses.

### Check signal format

```
[booth-check] round=1/5 Read /absolute/path/to/.booth/check.md and follow the self-verification procedure.
```

Paths are absolute (resolved from the project root). If `.booth/check.md` does not exist, a fallback message is sent instead:

```
[booth-check] round=1/5 Self-verify your work. Submit report via: booth report --status SUCCESS --body "your report with YAML frontmatter".
```

If the deck was spun with `--no-loop`, an additional suffix is appended: `Skip the sub-agent review loop. Write your report directly.`

## Terminal Report Statuses

| Status | Meaning |
|--------|---------|
| `SUCCESS` | Task completed and passed self-check |
| `FAIL` / `FAILED` | Task completed but failed self-check |
| `ERROR` | Abnormal crash during execution |
| `EXIT` | CC session self-exited (user `/exit`, timeout, crash) |

## Deck Exit — Six Scenarios

| Scenario | Trigger | Hook behavior | DJ notified? | DB status change |
|----------|---------|---------------|-------------|-----------------|
| A: `booth kill <name>` | DJ/user kills deck | kill-pane runs first, exitDeck (sync) follows immediately → hook IPC arrives after exitDeck → no match → silent exit | No (caller knows) | → exited (row preserved in DB) |
| B: CC self-exit (`/exit`) | CC exits gracefully | Hook fires → finds match in DB → writes EXIT report → IPC `deck-exited` → daemon notifyDj | Yes (`[booth-alert]`) | → exited |
| C: `tmux kill-pane` (external) | User/script kills pane | Same as B — CC receives SIGHUP → graceful exit → hook fires | Yes (`[booth-alert]`) | → exited |
| D: `booth stop` (global shutdown) | DJ/user stops everything | kill-pane → CC SIGHUP → hook fires → daemon already dead → socket connect fails → silent exit | No (daemon is dead) | **No change** (stays working/idle for resume) |
| E: `kill -9 <CC_PID>` (SIGKILL) | Force-kill CC process | Hook does NOT fire (SIGKILL is uncatchable) | No | No change until pruneStaleDecks |
| F: `kill -9 <daemon_PID>` | Force-kill daemon | Deck CC processes continue running (independent of daemon) | No (daemon is dead) | No change until new daemon starts + pruneStaleDecks |

### Scenario A: `booth kill <name>` (DJ/user initiated)

```
booth kill → IPC "kill-deck" → daemon:
  1. tmux kill-pane — sends SIGHUP to CC process
  2. exitDeck() — synchronous: UPDATE status='exited' + unwatch + clearTimers
  3. IPC handler returns { ok: true }
  --- later (async, separate process) ---
  4. CC receives SIGHUP → graceful exit → SessionEnd hook fires
  5. Hook queries DB → status already 'exited' (step 2) → no match → silent exit
```

No race condition: kill-pane triggers an async chain (SIGHUP → CC shutdown → hook → IPC), while exitDeck completes synchronously in the same event-loop tick. By the time the hook's IPC arrives, exitDeck has long finished. The DB row is preserved (never deleted) — visible in `booth ls -a`.

### Scenario B: CC self-exit (`/exit`, crash, timeout)

```
CC exits gracefully → SessionEnd hook fires:
  1. read stdin JSON {session_id, transcript_path, cwd, reason}
  2. query SQLite — match deck by jsonlPath (status != 'exited')
  3. submit EXIT report via IPC "submit-report" → daemon DB
  4. IPC "deck-exited" → daemon: exitDeck() + notifyDj()
```

DJ receives `[booth-alert]` and can decide to re-spin or acknowledge.

### Scenario C: `tmux kill-pane` (external kill)

Same path as Scenario B — CC receives SIGHUP and exits gracefully, firing the SessionEnd hook. DJ is notified.

### Scenario D: `booth stop` (global shutdown)

```
booth stop → IPC "shutdown" → daemon:
  1. kill all deck panes (but NOT exitDeck — status preserved)
  2. kill DJ tmux session
  3. close DB, IPC socket, daemon exits
  4. Each kill-pane → SIGHUP → CC → SessionEnd hook fires
  5. Hook tries to connect daemon socket → daemon already dead → silent exit
```

Deck status stays working/idle in DB. On next `booth` start, decks with status != 'exited' are resumable. `pruneStaleDecks` on daemon startup cleans any whose pane no longer exists.

### Scenario E: `kill -9 <CC_PID>` (SIGKILL)

SIGKILL is uncatchable — SessionEnd hook does NOT fire. Deck status is stale in DB until:
- Daemon health check detects pane disappeared → logs warning
- Next daemon startup → `pruneStaleDecks` → exitDeck for missing panes

### Scenario F: `kill -9 <daemon_PID>` (SIGKILL daemon)

Daemon dies immediately. Deck CC processes continue running independently (they don't depend on daemon). On next `booth` command:
- New daemon starts → loads DB → `pruneStaleDecks` checks pane liveness
- Living decks resume monitoring; dead decks get exitDeck'd
