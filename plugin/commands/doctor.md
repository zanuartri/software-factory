---
description: Health check of the factory — daemon, harness CLIs, guards, workspace config, orphaned runs and worktrees
---

Load the `factory-coordinator` skill first.

1. Run `factory doctor` and `factory status`.
2. For each ✖ line, fix what is safe to fix, and explain the rest:
   - missing harness CLI: disable that harness in settings (`factory settings set '{"harnesses":{...}}'`);
   - guards not installed: `factory setup`;
   - rules.md not scanned / verify recipe missing: offer `/factory:init`;
   - no cross-family reviewer: suggest enabling a second harness or changing `reviewer_order`;
   - orphan run: `factory tell <ticket> "resume"`, or kill it if the ticket is obsolete;
   - open tickets with invalid briefs: fix the brief or move them back to draft.
3. Also check `~/.factory/daemon.log` (last 50 lines) for errors, and check that `factory` resolves on PATH (`bun link` in the factory repo).

Report a short checklist: fixed, needs the human, fine.
