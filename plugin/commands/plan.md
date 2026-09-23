---
description: Brainstorm and grill an idea until it's sharp, then turn it into draft tickets with full briefs
argument-hint: "<idea, feature or problem> [--issue I-3]"
---

Load the `factory-coordinator` skill first.

1. Ground yourself: `factory status`, `.factory/rules.md`, and any issue named in `$ARGUMENTS` (`factory issue list`).
   Read the code the idea touches, using Explore subagents for anything broad. Facts are your job. Don't ask the
   human what the code can tell you.
2. Invoke the `grilling` skill on: $ARGUMENTS. Walk the design tree with the human until the frontier is empty and
   they confirm the shared understanding.
3. Decompose into tickets (the brief standard is in the coordinator skill): one concern each, PR-sized, ordered with
   `depends_on`, non-overlapping `scope_paths` where possible so they can run in parallel, and Verify commands that
   fail today. Put the grilling decisions each ticket depends on into its Context. Don't make the worker rediscover them.
4. Create each one with `factory ticket new --title "..." [--issue I-x] --tags ...`, then fill in the sections and
   frontmatter in the file. If they came from an issue, run `factory issue set I-x status=ticketed tickets=T-a,T-b`.
5. Show a table (id, title, deps, scope, timebox, harness, difficulty) and the dependency order. They stay **draft**.
   `/factory:release` opens them.
