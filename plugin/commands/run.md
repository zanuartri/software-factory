---
description: Put open tickets on workers and drive them until every one is in review, blocked, or failed
argument-hint: "[T-1 T-2 ...] [--hours N] [--max N]"
---

Load the `factory-coordinator` skill first.

1. `factory status`. If nothing is open, say so and stop.
2. `factory run $ARGUMENTS`. The daemon schedules by priority, respects `depends_on`, never runs overlapping scopes
   in parallel, and fills up to `max_workers` slots across the enabled harnesses.
3. Run the **drain loop** from the coordinator skill: `factory wait` in the background, handle each event (answer
   asks, unblock, rewrite failed briefs and re-run), repeat until you get `🏁 drained`. Watch progress in
   `factory ui` if the human wants to see it.
4. Final report: a table (ticket, status, harness, attempts, reviewer verdict), decisions you made for the human,
   and anything that needs them. Suggest `/factory:review` if tickets are in review.
