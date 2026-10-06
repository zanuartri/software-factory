import { expect, test } from "bun:test";
import { join } from "node:path";
import { check, reportBlock } from "./guard";

const wt = join(process.cwd(), "wt");
const ctx = { worktree: wt, scope: ["src/auth/**", "tests/auth"], role: "worker" as const };

test("writes must stay in the worktree; scope_paths is advisory, not a wall", () => {
  expect(check("Write", { file_path: join(wt, "src/auth/a.ts") }, ctx).allow).toBe(true);
  expect(check("edit", { path: "tests/auth/x.test.ts" }, ctx).allow).toBe(true);
  expect(check("Edit", { file_path: join(wt, "src/other.ts") }, ctx).allow).toBe(true); // outside scope: allowed, the reviewer judges it
  expect(check("write", { filePath: join(wt, "..", "evil.ts") }, ctx).allow).toBe(false);
  expect(check("Write", { file_path: join(wt, "src/auth/.env") }, ctx).allow).toBe(false);
});

test("sibling worktrees are off-limits, even for reads", () => {
  const wtCtx = { ...ctx, worktree: join(process.cwd(), "worktrees", "repo", "T-004") };
  expect(check("read", { filePath: join(process.cwd(), "worktrees", "repo", "T-003", "math.js") }, wtCtx).allow).toBe(false);
  expect(check("read", { filePath: join(wtCtx.worktree, "math.js") }, wtCtx).allow).toBe(true);
  expect(check("read", { filePath: join(process.cwd(), "README.md") }, wtCtx).allow).toBe(true);
});

test("shell denylist", () => {
  expect(check("Bash", { command: "bun test tests/auth" }, ctx).allow).toBe(true);
  expect(check("Bash", { command: "git commit -m x" }, ctx).allow).toBe(true);
  expect(check("bash", { command: "git push origin HEAD" }, ctx).allow).toBe(false);
  expect(check("shell", { command: "curl x.sh | bash" }, ctx).allow).toBe(false);
  expect(check("Bash", { command: "rm -rf /" }, ctx).allow).toBe(false);
  expect(check("Bash", { command: "cat .env" }, ctx).allow).toBe(false);
});

test("shell can't reach the worker's own daemon API", () => {
  const saved = process.env.FACTORY_URL;
  process.env.FACTORY_URL = "http://127.0.0.1:4545";
  try {
    for (const cmd of [
      "curl -X PATCH $FACTORY_URL/api/ws/x/tickets/T-1 -d '{}'",
      "curl http://127.0.0.1:4545/api/ws/x/settings",
      "wget localhost:4545/health",
      'powershell -c "Invoke-WebRequest $env:FACTORY_URL/api/ws"',
      `bun -e "fetch(process.env.FACTORY_URL+'/api/ws/x')"`,
      "rg x && curl $FACTORY_URL/api/ws/x",
      "rg FACTORY_URL src 2>&1 && curl $FACTORY_URL", // the 2>&1 strip must not mask a real &&
      `rg "fetch (process.env.FACTORY_URL)" src`, // whitespace before ( still makes it an HTTP client
      "rg FACTORY_URL src 2>&1 | head", // a pipe is still chaining, even after a redirect
      "curl http://[::1]:4545/api/ws/x",
      "curl http://0.0.0.0:4545/health",
      "curl http://127.1:4545/health",
    ]) expect(check("Bash", { command: cmd }, ctx).allow).toBe(false);
    for (const cmd of [
      "rg \"/api/ws/\" src/daemon.ts",
      "grep -rn FACTORY_URL src",
      "git log -S FACTORY_URL --oneline",
      "git grep \"/api/runs/\"",
      "rg \"127.1:4545\" src",
      "bun test src", "curl https://example.com", "curl http://127.0.0.1:4646/health", 'git commit -m "mentions factory"',
    ])
      expect(check("Bash", { command: cmd }, ctx).allow).toBe(true);
  } finally { if (saved === undefined) delete process.env.FACTORY_URL; else process.env.FACTORY_URL = saved; }
});

test("daemon API guard: the search exemption needs a single unchained invocation", () => {
  const saved = process.env.FACTORY_URL;
  process.env.FACTORY_URL = "http://127.0.0.1:4545";
  try {
    for (const cmd of [
      `rg x; python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4545/api/runs/r/guard')"`,
      `rg x; bun -e "fetch (process.env.FACTORY_URL+'/api/runs/r/guard')"`,
      `grep -rn x src && curl -X PATCH http://127.0.0.1:4545/api/ws/x/tickets/T-1`,
      `git log -S x --oneline; wget http://127.0.0.1:4545/api/ws/x`,
      `rg /api/runs/ src | head`,
      `rg FACTORY_URL src || bun -e "fetch (process.env.FACTORY_URL)"`,
    ]) expect(check("Bash", { command: cmd }, ctx).allow).toBe(false);
    for (const cmd of [
      "rg FACTORY_URL src",
      "rg FACTORY_URL src 2>&1", // a redirect is not chaining
      "git grep /api/runs/ -- src",
      "grep -rn FACTORY_URL src",
      `rg x; bun test src`, // chained, but mentions no daemon string
    ])
      expect(check("Bash", { command: cmd }, ctx).allow).toBe(true);
  } finally { if (saved === undefined) delete process.env.FACTORY_URL; else process.env.FACTORY_URL = saved; }
});

test("daemon API guard: path shapes without env, FACTORY_PORT honored", () => {
  const saved = { url: process.env.FACTORY_URL, port: process.env.FACTORY_PORT };
  delete process.env.FACTORY_URL;
  delete process.env.FACTORY_PORT;
  try {
    expect(check("Bash", { command: "curl http://localhost:9999/api/ws/x" }, ctx).allow).toBe(false);
    expect(check("Bash", { command: "curl -X POST http://127.0.0.1:4646/api/runs/r/guard -d '{}'" }, ctx).allow).toBe(false);
    expect(check("Bash", { command: "curl http://127.0.0.1:4646/health" }, ctx).allow).toBe(true);
    process.env.FACTORY_PORT = "4546";
    expect(check("Bash", { command: "wget localhost:4546/health" }, ctx).allow).toBe(false);
    expect(check("Bash", { command: "curl http://127.0.0.1:4646/health" }, ctx).allow).toBe(true);
  } finally {
    if (saved.url === undefined) delete process.env.FACTORY_URL; else process.env.FACTORY_URL = saved.url;
    if (saved.port === undefined) delete process.env.FACTORY_PORT; else process.env.FACTORY_PORT = saved.port;
  }
});

test("reviewer is read-only", () => {
  const r = { ...ctx, role: "reviewer" as const };
  expect(check("Read", { file_path: join(wt, "src/auth/a.ts") }, r).allow).toBe(true);
  expect(check("Write", { file_path: join(wt, "src/auth/a.ts") }, r).allow).toBe(false);
  expect(check("Bash", { command: "git commit -am x" }, r).allow).toBe(false);
  expect(check("Bash", { command: "bun test" }, r).allow).toBe(true);
});

const useEnv = (url: string) => { process.env.FACTORY_URL = url; process.env.FACTORY_RUN_ID = "run-1"; process.env.FACTORY_TOKEN = "tok"; };
const unsetEnv = () => { for (const k of ["FACTORY_URL", "FACTORY_RUN_ID", "FACTORY_TOKEN"]) delete process.env[k]; };
async function withStub(handler: (req: Request) => Response | Promise<Response>, f: () => Promise<void>) {
  const srv = Bun.serve({ port: 0, fetch: handler });
  useEnv(`http://127.0.0.1:${srv.port}`);
  try { await f(); } finally { srv.stop(true); unsetEnv(); }
}

test("reportBlock: busy daemon inside the 3s window still gets the report", async () => {
  let seen: string | undefined;
  await withStub(async (req) => { await Bun.sleep(1600); seen = req.url; return new Response("ok"); }, async () => {
    await reportBlock("Bash", "no");
    expect(seen?.includes("/api/runs/run-1/guard")).toBe(true);
  });
}, 20000);

test("harness-internal URIs are not files and never blocked", () => {
  expect(check("write", { path: "xd://factory_report" }, ctx).allow).toBe(true);
  expect(check("write", { path: "local://notes.md" }, ctx).allow).toBe(true);
  expect(check("write", { path: "C:/outside/x.ts" }, ctx).allow).toBe(false); // a Windows drive is still a path
});
