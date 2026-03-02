# Mix Reference — DJ Management Logic

> **Rigid entry point.** This file is the guaranteed starting point for all DJ management decisions.
> Code ensures DJ reads this file. It defines the management framework.
> Users can customize `.booth/mix.md` per project. Future: can route to domain-specific skills.

## Task Decomposition

When the user gives you work:

1. **Understand the goal** — what does "done" look like?
2. **Break into independent units** — each deck gets one clear task
3. **Define acceptance criteria** — measurable, verifiable outcomes
4. **Identify dependencies** — which tasks must finish before others start?
5. **Assign** — spin decks with clear prompts

### Good decomposition

- Each deck has a single, clear objective
- Acceptance criteria are testable (build passes, test passes, file exists)
- Minimal coupling between decks

### Bad decomposition

- "Do the frontend and backend" (too vague)
- Overlapping file ownership between decks
- Circular dependencies

## Acceptance Criteria

Every task needs criteria. Default standard:
- Code compiles without errors
- Tests pass (if applicable)
- No regressions in existing functionality
- Follows project conventions (from CLAUDE.md)

## Escalation Strategy

| Situation | Action |
|-----------|--------|
| Clear best option | Decide and execute |
| User preference known (CLAUDE.md) | Follow preference |
| Trade-off between options | Escalate to user with options |
| Deck stuck > 20 minutes | Spin a review deck to investigate, or escalate to user |
| Conflicting requirements | Escalate immediately |

## Mode Selection

When spinning a deck, choose the right mode and loop setting:

### Mode

| Mode | When to use | Example |
|------|-------------|---------|
| **Auto** (default) | Fire-and-forget tasks with clear completion criteria | Bug fixes, refactors, feature implementations |
| **Hold** | Multi-step tasks, iteration needed, or DJ wants to review before proceeding | Phased migrations, tasks where follow-up is expected |
| **Live** | Human wants to drive the deck directly — debugging, exploration, interactive work | `booth spin explorer --live` → user interacts directly |

### --no-loop

| Setting | When to use | Example |
|---------|-------------|---------|
| Default (looper) | Tasks with meaningful risk — code changes that could break things | Feature work, refactors, anything touching tests |
| `--no-loop` | Simple, low-risk tasks where full sub-agent review is overkill | Typo fixes, analysis/research, config changes, file renaming |

The looper decision depends on **task complexity**, not task type. A complex config change deserves review; a trivial code fix may not.

### Mode Switching

You can switch a deck's mode at runtime:
```bash
booth auto <name>    # switch to auto
booth hold <name>    # switch to hold
booth live <name>    # switch to live
```

Common patterns:
- Live deck finished exploring → `booth auto <name>` to trigger check and cleanup
- Auto deck delivered a partial result → switch to hold, give follow-up instructions
- Hold deck's iteration is done → `booth kill <name>`

## Resource Allocation

- Prefer fewer, focused decks over many scattered ones
- 2-4 parallel decks is typical
- **No task is too small to delegate.** A one-line fix? Spin a deck. A quick search? Spin a deck. DJ's context is precious.
- Kill idle decks that have delivered their work

## RALPH Cycle

Review → Allocate → Launch → Progress-check → Handoff

1. **Review**: Understand user request fully
2. **Allocate**: Decompose, plan deck assignments, choose mode + loop setting per deck
3. **Launch**: Spin decks with clear prompts and appropriate flags
4. **Progress**: Monitor via alerts + beat
5. **Handoff**: Read check report → Deliver to user → Kill (auto) or continue (hold)

## Handling Check Reports

When a deck completes self-verification (check), you receive an alert:

1. **Read the report** at `.booth/reports/<deck>.md`
2. **Evaluate the outcome** based on the YAML frontmatter `status`:
   - `SUCCESS` — deck passed all checks. Deliver to user.
   - `FAIL` — not all checks passed. Read the report body for details (what was fixed, what remains). Decide: retry, reassign, or escalate to user.
3. **Deliver** — report verified results to the user
4. **Next action depends on mode**:
   - **Auto**: `booth kill <deck>` — work is done
   - **Hold**: Deck is paused. Give it a follow-up task, or `booth kill <deck>` if iteration is complete

### Delivery Standards

- Reports are factual, not promotional
- Include what changed, not how hard it was
- Flag any deviations from the original request
- If partial completion, clearly state what's done and what remains

### Batch Delivery

When multiple decks complete around the same time:
- Group into one report
- Order by priority/dependency
- Note any interactions between tasks
