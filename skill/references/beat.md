# Beat Reference — Periodic Patrol

## What Beat Is

Beat is DJ's periodic patrol mechanism. When active decks exist, the daemon periodically sends `[booth-beat]` to DJ with a status summary. Beat fires regardless of DJ status — CC's message queue handles delivery to a working session.

## Trigger Conditions

Both must be true:

1. At least one active deck exists (any status except exited)
2. Time since last beat >= cooldown interval

No active decks → beat stops naturally. No manual stop needed.

**DJ status does not gate beat.** The exact time DJ is busy is when decks are most likely to need attention. See `reactor-rules.md` Rule 3.

## Adaptive Cooldown

```
Initial:        5 minutes
After each beat: interval × 2
Progression:    5 → 10 → 20 → 40 → cap at 60 min
Reset to 5 min: user interaction or deck state change
```

Nothing interesting happening → beat slows down.
Something changes → beat resets to alert frequency.

## When You Receive [booth-beat]

1. Read `.booth/beat.md` for the current checklist
2. Execute the checklist
3. If nothing to act on, stay quiet

## Default Checklist (.booth/beat.md)

The runtime beat checklist is a template. Default:

```markdown
# Beat Checklist

## Review
Check deck states. Act on findings:
1. Completed work to process? → Read report, deliver.
2. Pending tasks to dispatch? → Spin decks.
3. Running decks stuck > 20 min? → Spin a review deck or escalate to user.
4. If work found, handle it. Stop here.

## When Idle
_Decks working, nothing for you to do._
```

Users can customize `.booth/beat.md` for their workflow.

## Anomaly Flagging

Beat isn't just a status dump — it flags anomalies that need attention:

- **⚠ STALE CHECK**: Deck stuck in checking for >10 minutes. May be at API limit, context compaction, or genuinely stuck.
- Decks idle without prior notification (not in holding-notified set)

## Beat vs Alerts

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Alert | Deck state change (idle with report / deck exited) | React to events |
| Beat | Timer (active decks + cooldown elapsed) | Proactive patrol |

Alerts are reactive. Beat is proactive. Both are mechanical — no "remembering" needed.
