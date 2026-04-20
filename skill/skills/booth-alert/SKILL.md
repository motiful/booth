---
name: booth-alert
description: >-
  Booth daemon alert signal. Notifies DJ of deck state changes:
  check complete (report ready), deck exited unexpectedly.
  Activates when daemon injects /booth-alert into the DJ session.
---

# /booth-alert — DJ Notification Signal

This signal is injected by the Booth daemon when a deck needs DJ attention. All alerts are natural language — no structured type codes.

## Signal Format

```
/booth-alert <natural language description of what happened>
```

## What To Do

Follow the **booth-dj** skill's Alert Response Protocol:

1. Read the alert description
2. Identify scenario:
   - **Check complete** — run `booth status <deck>` (get Goal), then `booth reports <deck>` (get report). Evaluate report against Goal.
   - **Deck exited** — run `booth reports <deck>` for EXIT report. Re-spin if incomplete, acknowledge if expected.
3. Analyze before delivering — summarize in plain language, connect to plan progress
4. Clean up: kill completed decks, archive results

### Report Review Checklist

- Goal alignment (compare report against original spin prompt)
- Value delivery (does the fix solve the stated problem?)
- Root cause (fix or workaround? workarounds need justification)
- Completeness (runtime changes need E2E verification, not just compilation)
- Conflict check (do changed files conflict with other active decks?)
