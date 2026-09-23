# Verify recipe

Proven 2026-09-24 in bash (Git Bash). Uses an isolated daemon so the live one on :4545 is never touched.

## Launch
```bash
REPO=$(git rev-parse --show-toplevel)
T=$(mktemp -d); mkdir -p "$T/home" "$T/demo" "$T/evidence"
export FACTORY_PORT=4646 FACTORY_HOME="$T/home"
(cd ui && bun run build)            # only if ui/ changed; daemon serves ui/dist
bun "$REPO/src/daemon.ts" > "$T/evidence/daemon.log" 2>&1 & PID=$!
```
Ready when: `curl -sf http://127.0.0.1:4646/health` returns `{"ok":true,...}` (poll ≤15s).

## Doctor
`curl -sf http://127.0.0.1:4646/health` — read-only; `root` must equal `$REPO`.

## Drive
CLI (same env vars point it at :4646), inside a throwaway repo:
```bash
cd "$T/demo" && git init -q -b main && echo x > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init
bun "$REPO/src/cli.ts" init
bun "$REPO/src/cli.ts" ticket new --title "demo ticket"      # → T-001 ...md
bun "$REPO/src/cli.ts" status                                # board: draft 1
```
HTTP: `curl -s http://127.0.0.1:4646/api/ws/demo/tickets`. UI: `curl -s http://127.0.0.1:4646/ | grep '<title>Factory'`,
or open http://127.0.0.1:4646 in a browser for visual checks.

## Evidence
Save command output to `$T/evidence/` (`init.txt`, `status.txt`, `daemon.log`, screenshots). Paste the relevant lines into the Report.

## Cleanup
`kill $PID` (only the daemon you started). Leave `$T/evidence`. Never kill the :4545 daemon.

## Feature map
| feature | reach | prove |
|---|---|---|
| workspace init | `cli.ts init` in a git repo | output `workspace demo → ...`, `.factory/` created |
| tickets | `cli.ts ticket new/show/move/set` | file in `.factory/tickets/`, `status` board counts change |
| issues | `cli.ts issue new/list/set` | `issue list` shows it; file in `.factory/issues/` |
| guard (scope/shell) | `src/guard.ts` | `bun test src/guard.test.ts` |
| console UI | http://127.0.0.1:4646 | page `<title>Factory</title>`; board shows the ticket |
