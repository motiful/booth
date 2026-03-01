# Mix Reference — DJ Management Logic

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
| Deck stuck > 20 minutes | Investigate, then escalate if needed |
| Conflicting requirements | Escalate immediately |

## Resource Allocation

- Prefer fewer, focused decks over many scattered ones
- 2-4 parallel decks is typical
- Don't spin a deck for work that takes < 2 minutes
- Kill idle decks that have delivered their work

## RALPH Cycle

Review → Allocate → Launch → Progress-check → Handoff

1. **Review**: Understand user request fully
2. **Allocate**: Decompose and plan deck assignments
3. **Launch**: Spin decks with clear prompts
4. **Progress**: Monitor via alerts + beat
5. **Handoff**: Read check report → Deliver to user → Archive

## Handling Check Reports

When a deck completes self-verification (check), you receive an alert:

1. **Read the report** at `.booth/reports/<deck>.md`
2. **Evaluate the outcome** based on the YAML frontmatter `status`:
   - `SUCCESS` — deck passed all checks. Deliver to user.
   - `FAIL` — not all checks passed. Read the report body for details (what was fixed, what remains). Decide: retry, reassign, or escalate to user.
3. **Deliver** — report verified results to the user (see report format below)
4. **Archive** — move completed deck info to `.booth/archive/`

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
