---
description: Check draft tickets, tighten their briefs, and move them to open
argument-hint: "[T-1 T-2 ...] (default: all drafts)"
---

Load the `factory-manager` skill first.

For each draft ticket (the ones in `$ARGUMENTS`, or all drafts from `factory ticket list --status draft`):

1. `factory ticket show T-x`. Brief errors must be zero.
2. Review it against the brief standard and fix the file directly:
   - Is Goal a single outcome? Is each Acceptance line observable?
   - Would Verify actually **fail today**? Run it now if it's cheap. A Verify that already passes proves nothing.
   - Do `scope_paths` cover the code **and** the tests, without being wider than needed?
   - Does `depends_on` match the real order? Is the upstream context pasted in?
   - Is it too big (> ~400 lines or > 2h)? Split it.
   - Does any other open or in_progress ticket have overlapping scope? That's fine, but they will serialize. Note it.
3. `factory ticket move T-x open`.

Report a table: ticket, what you changed in the brief, and whether it's released. Don't start workers. That's `/factory:run`.
