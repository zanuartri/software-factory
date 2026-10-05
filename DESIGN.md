# Software Factory — design

Local factory: one **manager** (a Claude Code session, per repo) plans and drives headless **workers**
(claude, omp, commandcode) that each own one ticket in their own git worktree.
You talk only to the manager. The UI (clean console, light/dark) shows everything live and lets you steer.

Trust comes from structure, not hope (ideas from cursor/plugins `pstack`):

| idea | where |
|---|---|
| The brief is the product — a ticket missing GOAL/ACCEPTANCE/VERIFY/SCOPE can't be released | `store.ts validateBrief` |
| Standing orders pasted verbatim into every worker | `.factory/rules.md` → `prompts.ts` |
| Worker can't skip the gate: daemon re-runs VERIFY itself + checks diff stays in scope | `supervisor.ts gate()` |
| Verifier from a different model family than the implementer | `supervisor.ts pickReviewer()` |
| Decision log per run (what / why / evidence / result) | `~/.factory/runs/.../decisions.tsv` |
| Never block on the human: questions carry options + default + timeout | `factory_ask` |
| Encode lessons in structure: `reflect` proposes new rules lines | `/factory:reflect` in manager skill |
| One writer per worktree, scope overlap never scheduled in parallel | `supervisor.ts schedule()` |

## Layout

```
src/            daemon + CLI (Bun, zero server deps: Bun.serve + bun:sqlite)
  daemon.ts     HTTP API, WebSocket live feed, MCP endpoint, serves ui/dist
  db.ts         ~/.factory/factory.db — workspaces, runs, messages, events
  store.ts      <repo>/.factory/{tickets,issues}/*.md, rules.md, settings.json
  git.ts        worktrees, rebase, squash merge (CAS), revert, gc
  adapters.ts   HarnessAdapter for claude | omp | commandcode
  supervisor.ts scheduling, spawn, steer/abort, gate (scope + verify + cross-family review), merge
  mcp.ts        minimal MCP (streamable HTTP, JSON responses) — worker tools
  guard.ts      shared policy: writes stay in worktree+scope, no push/force/secret reads
  prompts.ts    worker / reviewer prompts
  cli.ts        `factory` CLI used by the manager + humans
harness/        omp extension (bridge to daemon + guard)
plugin/         Claude Code plugin `factory`: commands + skills
ui/             React + Vite + Tailwind ops console
```

## Ticket lifecycle

`draft → open → in_progress → in_review → done`, flags `blocked`, `failed`.

- `/factory:plan` writes drafts. `/factory:release` validates the brief and moves to open.
- `/factory:run` (and `auto`) schedules open tickets: deps done/in_review, no `scope_paths` overlap with running, free slot.
- Worker loop inside the harness: planner → implementer (small commits) → tester → self-review, then `factory_submit`.
- Daemon gate on submit: diff ⊆ scope_paths, VERIFY commands pass (evidence saved), cross-family reviewer PASS.
  Fail → findings sent back to the worker (max 3 attempts) → `failed`.
- `/factory:review`: auto-merge when green — merge base into the branch (worker resolves conflicts), re-verify, squash, CAS update of base, full-suite verify on base, auto-revert on red.

## Harness matrix

| harness | control | steer | abort | factory tools | guard |
|---|---|---|---|---|---|
| claude | `claude -p` stream-json in/out | stdin user msg | control_request interrupt | `--mcp-config` HTTP | `--settings` PreToolUse hook |
| omp | `omp --mode rpc` | rpc `steer` | rpc `abort` | extension tools → HTTP | extension `tool_call` block, `--approval-mode yolo` |
| commandcode | `commandcode -p` NDJSON | piggyback | kill + `--resume` | `mcp add --scope local` per worktree | `~/.commandcode/settings.json` PreToolUse (env-gated) |

Piggyback: every factory tool response carries pending manager messages, and the worker skill calls
`factory_report` at every phase/unit boundary.

## Operational notes (learned the hard way on Windows)

- `.cmd` shims are resolved to the real exe/script (`adapters.bin`). Killing a shim orphans the child, and orphans keep the daemon's inherited socket bound.
- `factory down` calls `/api/shutdown`, which kills every worker tree before the daemon exits. `factory tell` resumes them.
- Non-page paths (`/.well-known`, `/api`, `/mcp`) return 404. MCP clients doing OAuth discovery hang on an HTML 200.
- The gate ignores untracked junk outside scope (harness caches), because only committed work is merged.
- A worker started without a resumable session always gets its full brief (`WORKER_MARK`).
- Sibling worktrees are off-limits to reads as well as writes.
- Parked (idle/paused) runs hold a worktree but no slot. `schedule()` is re-entrancy guarded.
