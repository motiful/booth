# Check Reference — Deck Self-Verification

> This document is read by **decks** when they receive `[booth-check]`.
> It defines the self-review loop using a sub-agent.

## When You Receive [booth-check]

You have finished your task. Before it's delivered, you must verify your own work.

## The Review Loop

1. **Spawn a sub-agent** to review your changes
2. **Read the sub-agent's findings**
3. **Fix any issues found**
4. **Repeat** until exit condition is met
5. **Write the report**

### Sub-Agent Invocation

Use Claude Code's built-in sub-agent capability:
- The sub-agent **reviews only** — it does not modify code
- The sub-agent inherits your model
- Give it clear scope: what files changed, what the task was, what the acceptance criteria are

### What the Sub-Agent Checks

- Does the code compile?
- Do tests pass?
- Are acceptance criteria met?
- Any regressions?
- Does the code follow project conventions (CLAUDE.md)?
- Any security issues, edge cases, or obvious bugs?

## Exit Conditions

| Condition | Status | Action |
|-----------|--------|--------|
| Sub-agent finds **no issues** in a round | `SUCCESS` | Write report, done |
| **5 rounds** reached (hard limit) | `FAIL` | Write report with remaining issues |
| Same findings **2 rounds in a row** | `FAIL` | Write report — stuck, needs escalation |
| Remaining issues **beyond your scope** (design questions, unclear requirements, needs user decision) | `FAIL` | Write report — fixed items + remaining for DJ |

## Report Format

Write the report to `.booth/reports/<your-deck-name>.md`:

```markdown
---
status: SUCCESS | FAIL
rounds: 3
deck: auth-refactor
timestamp: 2026-03-02T14:30:00Z
---

## Task Summary

One-sentence description of what was done.

## Changes

- file1.ts: added authentication middleware
- file2.ts: updated route handlers

## Review Rounds

### Round 1
- Found: missing error handling in login route
- Fixed: added try/catch with proper error response

### Round 2
- Found: no test for edge case
- Fixed: added test for expired token

### Round 3
- No issues found

## Final Artifacts

- src/auth/middleware.ts (new)
- src/routes/login.ts (modified)
- tests/auth.test.ts (new)
```

## Idempotency

If you receive `[booth-check]` after a context compaction:
1. Re-read this document
2. Check if `.booth/reports/<your-deck-name>.md` already exists
3. If it exists with a terminal status (SUCCESS/FAIL), you're done — stay idle
4. If it doesn't exist, start the review loop from the beginning

## What You Don't Do

- Don't skip the review — every task gets checked
- Don't modify the report format — DJ depends on the YAML frontmatter
- Don't spin sub-sub-agents — CC doesn't allow nested sub-agents
