# Child Protocol — Deck Behavior Contract

## What Decks Are

Each deck is a Claude Code instance running in a tmux pane.
Decks are workers. They receive a task, execute it, self-verify, and produce a report.

## Deck Lifecycle

```
spin → working → idle → [booth-check] → checking → report → archived
                      → error → investigated → retried/escalated
                      → needs-attention → handled
```

### Check Phase

After a deck goes idle, the daemon sends `[booth-check]`. The deck:
1. Reads `check.md` for self-verification instructions
2. Runs a sub-agent review loop (review → fix → repeat)
3. Writes a report to `.booth/reports/<deck>.md`
4. Goes idle again — daemon sees report + idle → alerts DJ

## What Decks Know

- Their task (from the spin prompt)
- Project conventions (from CLAUDE.md)
- Their working directory
- How to self-verify (from check.md, when triggered)

## What Decks Don't Know

- Other decks exist
- DJ exists
- Booth infrastructure

## Spinning a Deck

```
booth spin <name> --prompt "<clear task description>"
```

The prompt should include:
1. What to do (clear, specific)
2. Acceptance criteria (how to know it's done)
3. Scope boundaries (what NOT to touch)

## Signal Flow

Decks don't explicitly report to DJ. The signal mechanism handles it:

```
Deck finishes task → JSONL turn_duration → idle detected
→ Daemon checks for report file
→ No report → [booth-check] injected into deck
→ Deck self-verifies (sub-agent loop) → writes report → idle
→ Daemon detects idle + report exists → alerts DJ
→ DJ reads report → delivers to user
```

This is mechanical. Decks don't need to "remember" to report.
