---
description: Drive the whole board to done — tickets, auto-merge of green ones, and every follow-up or bug they spawn
argument-hint: "[--hours N] [--max N] [--rounds N]"
---

Load the `manager` skill first. The human is **away**. Make reversible calls yourself and write them down.
Park irreversible or product-level asks instead of answering them: leave them parked and list them in the
final report. Never push, never force.

**Exit predicate:** no ticket in draft/open/in_progress/in_review/blocked and base verify green. Issues in
open/triaged count too, except the parked ones: an issue you parked (its reason says parked, or you left it
parked as a product call) can never close, so exclude it and list it in the final report instead of looping
on it. Stop earlier when the round budget (default 5, `--rounds` from `$ARGUMENTS`) or the time budget
(`--hours`) is used up, or when a ticket failed twice after a brief rewrite: stop on it, report it.

Each round:

1. **Triage.** Triage open issues and turn the triaged ones into tickets as in `/factory:auto` steps 1-3
   (conservative reading, assumptions into Context, no grilling). Release drafts.
2. **Run.** `factory run` with `--hours`/`--max` forwarded from `$ARGUMENTS`, plus the drain loop from the manager
   skill: answer reversible asks yourself, unblock workers, rewrite failed briefs and re-run them (stop a ticket
   after its second failure).
3. **Review & merge.** Review every `in_review` ticket by the manager skill's review/merge policy: green →
   `factory merge T-x`; not green → do NOT merge, put the 5-line summary in the final report.
4. **File issues.** Every minor finding, worker follow-up and bug you notice becomes an issue
   (`factory issue new`) so the next round turns it into tickets.
5. **Next round** while the exit predicate is false.

Final report: a table of tickets (id, status, merged sha, attempts, verdict), issues closed/created per round,
decisions you made on the human's behalf, parked issues and questions (with their reasons), and failed/blocked
tickets with the next step.

This command is self-driving: keep the drain loop going with `factory wait` always in the background, handle each
event, review and merge, then start the next round until the exit predicate holds or the round/time budget is
used up. Do not stop to ask the human to set anything up. Optional: running it under the built-in `/goal` only
keeps the session from stopping early; never print or require a `/goal` line.
