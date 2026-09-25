# Standing orders

1. Runtime is Bun (not Node). Use `bun`, `bun test`, `bunx`; never npm/pnpm/yarn.
2. Before submitting run: `bun test src` and `bunx tsc -p .` (both must exit 0).
3. If you touched `ui/`: also run `cd ui && bunx tsc -p . --noEmit && bun run build`.
4. Run one test file with `bun test src/<name>.test.ts`.
5. Tests are colocated `src/*.test.ts` using `bun:test` (`test`/`expect`), flat `test()` calls, no mocking framework, no fixtures dirs.
6. Every behavior change in `src/` gets a test that fails before your change; UI changes need no unit test but must build.
7. No new dependencies in either package.json unless the brief says so.
8. Keep the existing style: dense one-line handlers, short names, no classes for single-use code, no new abstraction layers.
9. Imports use relative paths without extension (`./db`), `node:` prefix for builtins.
10. Daemon routes live in the `routes` table in `src/daemon.ts`; errors are thrown and turned into 400 JSON by `wrap` — don't add try/catch per route.
11. CLI output goes through `out()`, fatal errors through `die()` in `src/cli.ts`.
12. SQLite schema lives in `src/db.ts`; any schema change must be additive (new column/table with default), never drop or rename.
13. Never run `factory`, `bun src/cli.ts` or `src/daemon.ts` yourself (the CLI auto-starts a daemon that disrupts live runs); test CLI behavior only via spawned processes with `FACTORY_PORT` set to a free port and a temp `FACTORY_HOME`. The coordinator does live checks.
14. Forbidden paths: `bun.lock`, `ui/bun.lock`, `ui/dist/**`, `node_modules/**`, `.factory/**`, `.env*`.
15. Changes to `plugin/**` or `harness/**` are prompts/contracts other agents read — edit only when the brief names them.
16. Commits: conventional style `type(scope): summary` (feat, fix, polish, chore), lowercase, imperative.
17. Tests that spawn `daemon.ts` or `cli.ts`: temp `FACTORY_HOME` set before imports, a free port, and accept `/health` only when its `pid` is the process you spawned (other suites run in parallel).
18. A settings/routing change must keep behavior identical when the catalog is empty; say in the Report how you proved it.
