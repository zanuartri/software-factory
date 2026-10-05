---
description: Autonomous mode — triage issues, turn them into tickets, release, and run workers until everything is in review (never merges)
argument-hint: "[--hours N] [--max N] [I-1 I-2 ...]"
---

Load the `manager` skill first. The human is **away**. Never block on them. Make reversible calls
yourself and write them down. Park irreversible ones.

**Exit predicate:** every ticket created in this run is `in_review`, `blocked`, or `failed` with a write-up, or the
budget has run out. Budget: `--hours`/`--max` from `$ARGUMENTS`, else `auto_budget` in settings. The daemon stops
spawning at 70% of the budget.

1. **Triage.** Triage the issues named in `$ARGUMENTS`, or else all `open` issues, as in `/factory:issue` (no
   arguments). Mark each triaged/stale/closed with evidence.
2. **Ticket.** For each triaged issue, decompose it into draft tickets with full briefs (as in `/factory:plan`, but
   without grilling). Resolve ambiguity with the most conservative reading of the issue and record the assumption in
   Context. Then `factory issue set I-x status=ticketed tickets=...`.
3. **Release.** Apply the `/factory:release` checks to those drafts and open them.
4. **Run.** `factory run <those tickets> --auto [--hours N --max N]`, then the drain loop. Answer asks yourself.
   Irreversible or product asks stay unanswered and go into the report.
5. **Stop at in_review.** Do not merge. Final report for when the human is back: issues → tickets map, a status table,
   the decisions you made for them (with reasons), parked questions, and failed/blocked tickets with the next step
   you recommend. Suggest `/factory:review`.
