---
name: booth-beat
description: >-
  Booth daemon beat signal. Periodic patrol for DJ: review deck states,
  process completed work, dispatch pending tasks, detect anomalies.
  Activates when daemon injects /booth-beat into the DJ session.
---

# /booth-beat — DJ Periodic Patrol Signal

This signal is injected by the Booth daemon on a cooldown schedule (5 -> 10 -> 20 -> 40 -> 60 min). It fires regardless of DJ status and serves as a fallback if individual alerts were lost.

## Signal Format

```
/booth-beat Status update:
  Working: deck-a, deck-b
  Checking: deck-c
  Idle: deck-d
  Pending tasks: 2
```

## What To Do

Follow the **booth-dj** skill's Beat Response Protocol:

1. Run `booth ls` and `booth reports` to review current state
2. Act on findings:
   - Completed work to process? Read report, deliver to user
   - Stuck decks (>20 min in checking)? Investigate or escalate
3. **Proactive dispatch** — if active decks < 3, check `.claude/progress.md` for pending work. Spin immediately. Don't ask user.
4. Nothing actionable AND no pending work? Stay quiet — don't waste tokens

### Anomaly Flags

- **STALE CHECK** — deck stuck in checking >10 min, may be at API limit or genuinely stuck
- **Unnotified idle deck** — deck went idle but DJ hasn't been alerted yet
