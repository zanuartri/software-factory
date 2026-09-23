---
description: Mine recent gate failures, asks and blocks for repeated mistakes and turn them into standing orders
---

Load the `factory-coordinator` skill first, and follow its **Reflect** section:

1. Collect the evidence: `factory asks --all`, blocked/failed tickets in `factory ticket list`, and
   `~/.factory/runs/<ws>/*/*/gate-*/findings.md` plus `review.md` from recent runs (use a subagent to read them in bulk).
2. Group the findings by root cause. A lesson counts only if it repeated (≥ 2 tickets) or cost a failed attempt.
3. Propose each lesson as one numbered line for `.factory/rules.md` (a concrete constraint, not advice). Where it can
   be a check instead (a lint rule, a Verify command, a guard pattern), propose that. Structure beats prose.
4. Ask the human which ones to apply (multiSelect), then append them.
