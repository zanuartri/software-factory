# Software Factory

A local factory for headless coding agents. You talk to one **manager** (a Claude Code session). It plans
tickets and hands each one to a **worker**: claude, omp or commandcode, each in its own git worktree.
Workers can't mark their own homework. The daemon re-runs the ticket's Verify commands, checks that the diff
stays in scope, and has a **different model family** review the work before a ticket reaches review. Green
tickets auto-merge. If the base branch breaks after a merge, the merge is reverted automatically.

Design and rationale: [DESIGN.md](DESIGN.md).

## Install

One command per line (works in PowerShell and bash):

```
bun install
cd ui; bun install; bun run build; cd ..
bun link                                        # puts `factory` on PATH (open a new terminal after)
factory setup                                   # env-gated guards for commandcode (no-op outside factory runs)
claude plugin marketplace add ./
claude plugin install factory@software-factory
factory doctor
```

## Use

In Claude Code, inside the repo you want to work on:

| command | what happens |
|---|---|
| `/factory:init` | registers the repo, makes this session its manager, scans the repo into `.factory/rules.md` (standing orders) and `.factory/verify.md` (a proven verify recipe), and tunes settings |
| `/factory:plan <idea>` | grills you until the design is sharp, then writes draft tickets with full briefs |
| `/factory:release` | tightens the briefs (Verify must fail today, scope is right, not too big) → open |
| `/factory:run` | schedules open tickets onto workers and answers their questions until everything is in review |
| `/factory:review` | checks gate evidence and diffs, then auto-merges the green tickets |
| `/factory:issue [text]` | files an issue, or triages open ones (still valid? duplicate? fixed?) |
| `/factory:auto` | issues → tickets → release → run, stopping at in_review, with a time and ticket budget; it never merges |
| `/factory:finish` | rounds of issues → tickets → run → review → auto-merge green tickets until the board is done or the round/time budget runs out |
| `/factory:status` · `/factory:doctor` · `/factory:gc` · `/factory:reflect` | status, health check, worktree cleanup, and turning lessons into rules |

Live console: `factory ui` (http://127.0.0.1:4545). It has workers with phase progress, questions, activity,
a board, a ticket drawer (brief, report, runs with decision log and evidence, diff), issues, rules, and settings.
Light, dark, or system theme.

## Layout

```
src/        daemon (Bun.serve + bun:sqlite), CLI, adapters, supervisor, gate, guard, minimal MCP
harness/    omp extension (factory tools + guard)
plugin/     Claude Code plugin: /factory:* commands + manager / worker / reviewer skills
ui/         React + Vite + Tailwind console
~/.factory  factory.db, worktrees/<ws>/<ticket>, runs/<ws>/<ticket>/<run> (transcripts, decisions.tsv, gate evidence)
```

## Env

`FACTORY_PORT` (default 4545) and `FACTORY_HOME` (default `~/.factory`). Set both to run an isolated instance.

Cost-first routing is off by default: workers and reviewers use their configured settings. Set `cost_routing: true` to route through a model catalog. Catalogs can be global at `~/.factory/catalog.json` or configured per repo with the same shape (`"<harness>:<model>"` → `{ cost, quality, family, caps? }`). A non-empty repo catalog overrides the global catalog; a new repo inherits the global one. `factory doctor` reports catalog routing information.
