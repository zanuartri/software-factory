---
description: Register this repo as a factory workspace, make this session its manager, and scan the repo into standing orders + a verify recipe
argument-hint: "[--force]"
---

Load the `manager` skill first.

1. Run `factory init --session ${CLAUDE_SESSION_ID} $ARGUMENTS`. If it says another manager is live, tell the
   human and only continue with `--force` if they agree.
2. Run `factory doctor`. If the commandcode guard aren't installed and that harness exists, run `factory setup`.
3. **Scan the repo.** Send 2–3 parallel read-only Explore subagents so your own context stays small. Answer from the
   code, not from the human:
   - stack, package manager, and the exact **build / test / lint / typecheck** commands (from package scripts,
     Makefile, CI config, README), plus how to run a single test file;
   - conventions: naming, module layout, error handling, test style, commit style (`git log --oneline -30`);
   - areas/modules → **tags**; generated, vendored, lockfile, migration, and secret paths → **forbidden**;
   - what a user touches (web UI / CLI / API / library) and how an agent can drive it.
4. Write `.factory/rules.md` as **numbered standing orders**, one constraint per line, ≤ 25 lines. Include: commands
   to run before submitting, conventions that matter, forbidden paths, and the test style required.
5. Write `.factory/verify.md`, the **verify recipe** (pstack create-verification-skill): Launch (exact command +
   readiness signal), Doctor (one read-only check), Drive (real commands/selectors for this repo), Evidence (what to
   capture, where), Cleanup (kill only what you started; keep evidence), and a short **feature map** of the top 3–5
   user-facing features with how to reach and prove each. **Prove it once:** run launch → doctor → drive one feature →
   cleanup, and fix the recipe until it works.
6. Update settings with `factory settings set '{...}'` (or, PowerShell-safe, `factory settings set max_workers=3 verify_cmd="bun test"`): `base_branch`, `verify_cmd` (the full suite that must pass on
   base after every merge), `allowed_tools` (Claude Bash allowlist for this stack), harness enable flags and default
   models for what's installed, `default_harness`, `max_workers`, and `reviewer_order` (the first entry must differ
   from `default_harness` for cross-family review).
7. Show the human a summary (stack, commands, rules count, verify recipe proven y/n, settings). Ask before committing
   `.factory/` (`chore(factory): init workspace`).
