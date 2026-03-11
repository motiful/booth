# Child Protocol — Deck Behavior Contract

## What Decks Are

Each deck is a Claude Code instance running in a tmux pane.
Decks are workers. They receive a task, execute it, self-verify, and produce a report.

## Deck Modes

Every deck has a mode that determines its lifecycle after completing work:

| Mode | Flag | Behavior after work |
|------|------|-------------------|
| **Auto** | (default) | check → report → notify DJ → killed |
| **Hold** | `--hold` | check → report → notify DJ → **paused** (awaits next instruction) |
| **Live** | `--live` | No auto check — human drives the deck directly |

Modes can be switched at runtime via `booth auto/hold/live <name>`.

## Deck Lifecycle

### Auto Mode (default)

```
spin → working → idle → [booth-check] → checking → report → notify DJ → kill
```

The standard fire-and-forget lifecycle. Deck works, self-verifies, reports, and is killed.

### Hold Mode

```
spin → working → idle → [booth-check] → checking → report → notify DJ → pause
  ↑                                                                       │
  └──────────────── next instruction ─────────────────────────────────────┘
```

After check, the deck pauses and waits. DJ can give it another task (it resumes working) or kill it. Useful for multi-step workflows and iterative tasks.

### Live Mode

```
spin → (human interacts directly) → ... → (DJ switches mode or kills)
```

No automatic check. The deck is a raw CC session for the human to use. When done, DJ can switch it to auto/hold to trigger a check, or kill it directly.

**Edge case:** If a check was already in-flight when mode switched to live (i.e., `checkSentAt` is set), the check completes normally. Subsequent idles will not trigger new checks.

### Check Phase

After a deck goes idle (auto/hold modes only), the daemon sends `[booth-check]`. The deck:
1. Reads `.booth/check.md` for self-verification instructions
2. Runs a sub-agent review loop (review → fix → repeat) — unless `--no-loop` was set, in which case it writes the report directly
3. Writes a report to `.booth/reports/<deck>.md`
4. Goes idle again — daemon sees report + idle → notifies DJ

## Deck Environment

Each deck's tmux pane has these environment variables:

| Variable | Value | Purpose |
|----------|-------|---------|
| `BOOTH_DECK_ID` | UUID (session ID) | Unique identity for this deck session |
| `BOOTH_DECK_NAME` | Deck name | Human-readable name |
| `BOOTH_ROLE` | `deck` | Distinguishes deck from DJ |

`BOOTH_DECK_ID` is the CC session UUID — the same value stored as `session_id` in the `sessions` table. It is used by hooks (e.g., session-start-hook) to associate events with a specific deck.

## What Decks Know

- Their task (from the spin prompt)
- Project conventions (from CLAUDE.md)
- Their working directory
- How to self-verify (from `.booth/check.md`, when triggered)

## What Decks Don't Know

- Other decks exist
- DJ exists
- Booth infrastructure

## Forbidden Commands

Decks MUST NEVER execute the following booth commands:

| Command | Why forbidden |
|---------|--------------|
| `booth stop` | Kills the entire tmux session — DJ, all other decks, everything dies |
| `booth restart` | Internally runs stop — same destruction |
| `booth shutdown` | Alias for stop |

The only booth command a deck MAY run is `booth reload` (hot-restart daemon code without killing any pane). Even this should be rare — decks are workers, not infrastructure operators.

## Spinning a Deck

```bash
booth spin <name> --prompt "<clear task description>"               # auto + looper (default)
booth spin <name> --prompt "..." --no-loop                          # auto, skip review
booth spin <name> --live                                            # live mode
booth spin <name> --hold --prompt "..."                             # hold + looper
booth spin <name> --hold --no-loop --prompt "..."                   # hold, skip review
```

The prompt should include:
1. What to do (clear, specific)
2. Acceptance criteria (how to know it's done)
3. Scope boundaries (what NOT to touch)

## Signal Flow

Decks don't explicitly report to DJ. The signal mechanism handles it:

**Auto/Hold decks:**
```
Deck finishes task → JSONL turn_duration → idle detected
→ Daemon checks for report file
→ No report → [booth-check] injected into deck
→ Deck self-verifies (sub-agent loop, or direct report if --no-loop) → writes report → idle
→ Daemon detects idle + report exists → notifies DJ
→ Auto: DJ reads report → kill deck
→ Hold: DJ reads report → deck pauses → DJ gives next instruction or kills
```

**Live decks:**
```
Deck finishes task → JSONL turn_duration → idle detected
→ Nothing happens (no auto check)
→ Human continues interaction, or DJ switches mode/kills
```

This is mechanical. Decks don't need to "remember" to report.
