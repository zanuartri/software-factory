---
name: ticketing
description: How to write factory tickets that headless workers can execute and the gate can verify: sizing, the brief template, Verify and scope guidance, difficulty and harness routing, and brief templates per ticket type. Load when planning, releasing, or rewriting a failed ticket.
---

# Ticketing: the brief is the product

A worker cannot ask you what you meant. A vague brief fails quietly and costs an attempt. A good brief is short,
concrete, and checkable. Spend your care here, not on supervising.

## Shape of a ticket

- **One concern, PR-sized**: about ≤ 400 changed lines, one reviewer sitting. Bigger? Split and chain with `depends_on`.
- **Goal**: one sentence of outcome that a stranger with no chat access could execute.
- **Context**: `file:line` pointers, the data shapes involved, decisions already made with the human (don't make the
  worker rediscover them), and the upstream ticket's Report pasted if this one depends on it.
- **Acceptance**: checkable `- [ ]` lines, each observable (behavior, output, test). Never "code is clean".
- **Verify**: exact commands that **fail before and pass after**. Targeted tests plus the repo's typecheck/lint. Run
  it yourself first if it's cheap: a Verify that already passes proves nothing.
- **scope_paths**: where you expect the change, **including the tests**. It is guidance: it drives which tickets may run
  in parallel (overlapping scopes serialize) and tells the reviewer what to expect. It is not a wall, so don't agonize.
- **Timebox**: 15m–2h. Longer means the ticket is too big.
- **Forbidden**: unit-specific bans (no new dependency, no schema change, public API frozen ...). Only what matters.
- **difficulty**: `low` / `medium` / `high`. It drives cost-first routing, so set it honestly. Leave `harness`/`model`
  as `any`/`default` unless you have a reason (e.g. UI-heavy → a model strong at frontend).

## Sizing heuristics

- Touches > 5 files across modules, or needs two unrelated verifications → split.
- "Investigate, then fix" → two tickets (a research ticket whose output is a written finding, then the fix).
- A refactor and a behavior change never share a ticket.
- Prefer many small tickets with clear deps over one heroic ticket. Parallelism is free; rework isn't.

## Brief templates by type

**Bug**: Goal: the symptom is gone. Context: repro steps, the suspected code path with `file:line`, expected vs actual.
Acceptance: a regression test that fails today and passes after; the repro no longer reproduces. Verify: the test
command + typecheck. Persona hint: tag `bug`.

**Feature**: Goal: the user-visible outcome. Context: where it plugs in, data shapes, the design decisions made.
Acceptance: one line per user-visible behavior, including the empty/error state. Verify: tests for each behavior
+ the build. Tag `feature`.

**Refactor**: Goal: structure change with **identical behavior**. Acceptance: existing tests pass unchanged; the
specific smell is gone (name it); no behavior diff. Verify: the full suite for the touched module. Tag `refactor`.

**UI**: Goal: what the user sees and does. Acceptance: states (loading, empty, error), responsive behavior, keyboard
and a11y basics. Verify: build + typecheck + a driven check of the real page (use `.factory/verify.md`). Tag `ui`.

**Test-only**: Goal: coverage for a named behavior. Acceptance: each new test fails when the behavior breaks (mutate
to prove it). Tag `test`.

**Research**: Goal: a written answer to a question. Acceptance: the Report answers it with evidence (file:line,
command output) and a recommendation; no source changes. Verify: none needed, but state "no code change expected".
Tag `research`.

## Anti-patterns

- Acceptance that restates the Goal. Verify that can't fail. Scope `**/*`.
- Pasting a whole file into Context instead of pointing at `file:line`.
- Pinning `harness`/`model` out of habit. Letting the router choose is cheaper and usually better.
- Ten rules in Forbidden. If everything is forbidden the worker freezes.
- Releasing a ticket whose upstream hasn't landed: add `depends_on` and paste the interface it will expose.

## When a ticket fails

The brief is usually the bug. Read the gate findings and the worker's Report, then fix Context/Acceptance/Verify or
split it, reset with `factory ticket set T-x failed= status=open`, and run it again. Don't just retry.
