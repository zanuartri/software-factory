---
description: Clean up worktrees and branches that are safe to remove (merged / done tickets)
---

1. `factory gc` (dry run). It only lists worktrees and branches of tickets that are `done`, deleted tickets, or branches
   fully merged into base. It never touches live runs.
2. Show the list. Everything on it is safe by construction, so apply it with `factory gc --apply`, unless the human
   told you to keep something.
3. Also look for stale run artifacts older than 30 days in `~/.factory/runs/<ws>/`. List their size and offer to
   delete them (ask first: they are evidence).
