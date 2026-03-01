# Beat Reference — Periodic Patrol

## What Beat Is

Beat is DJ's periodic patrol mechanism. When decks are working and DJ is idle, the daemon sends `[booth-beat]` to prompt DJ to check on things.

## Trigger Conditions

All three must be true simultaneously:

1. At least one deck status is `working`
2. DJ status is `idle`
3. Time since last beat >= cooldown interval

No working decks → beat stops naturally. No manual stop needed.

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
3. Running decks stuck > 20 min? → Investigate.
4. If work found, handle it. Stop here.

## When Idle
_Decks working, nothing for you to do._
```

Users can customize `.booth/beat.md` for their workflow.

## Beat vs Alerts

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Alert | Deck state change (idle/error/needs-attention) | React to events |
| Beat | Timer (DJ idle + decks working) | Proactive patrol |

Alerts are reactive. Beat is proactive. Both are mechanical — no "remembering" needed.
