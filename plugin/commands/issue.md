---
description: File a new issue, or triage existing issues (still valid? duplicate? already fixed?)
argument-hint: "[description of a bug/idea to file] (empty = triage open issues)"
---

Load the `manager` skill first.

**If `$ARGUMENTS` is not empty**, file it: write a clear title, then a body with symptoms, repro steps (if a bug),
expected vs actual, and suspected area with `file:line` if you can find it quickly. Pick a kind: bug/feature/chore.
Check `factory issue list` for duplicates first. If there's a duplicate, add to it instead. Then run
`factory issue new --title "..." --kind bug --tags ... --body "..."`.

**If it's empty**, triage every `open` issue (`factory issue list --status open`). Use parallel read-only subagents when there are many:

- Is it still valid on the current base? For a bug, try to reproduce it (use `.factory/verify.md` to drive the app)
  or find the code path. For a feature, check whether it already exists.
- Is it a duplicate of another issue or of an open/done ticket?
- Then run `factory issue set I-x status=triaged|stale|closed reason="<evidence: command output, file:line, dup of I-y>"`.

Report a table: issue, verdict, evidence. `/factory:plan --issue I-x` or `/factory:auto` turn triaged issues into tickets.
