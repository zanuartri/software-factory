import { expect, test } from "bun:test";
import { join } from "node:path";
import { check, liveScope } from "./guard";

const wt = join(process.cwd(), "wt");
const ctx = { worktree: wt, scope: ["src/auth/**", "tests/auth"], role: "worker" as const };

test("writes must stay in worktree and scope", () => {
  expect(check("Write", { file_path: join(wt, "src/auth/a.ts") }, ctx).allow).toBe(true);
  expect(check("edit", { path: "tests/auth/x.test.ts" }, ctx).allow).toBe(true);
  expect(check("Edit", { file_path: join(wt, "src/other.ts") }, ctx).allow).toBe(false);
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
    ]) expect(check("Bash", { command: cmd }, ctx).allow).toBe(false);
    for (const cmd of ["bun test src", "curl https://example.com", "curl http://127.0.0.1:4646/health", 'git commit -m "mentions factory"'])
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

const liveCtx = { worktree: wt, scope: ["src/auth/**"], role: "worker" as const };
const useEnv = (url: string) => { process.env.FACTORY_URL = url; process.env.FACTORY_RUN_ID = "run-1"; process.env.FACTORY_TOKEN = "tok"; };
const unsetEnv = () => { for (const k of ["FACTORY_URL", "FACTORY_RUN_ID", "FACTORY_TOKEN"]) delete process.env[k]; };
async function withStub(handler: (req: Request) => Response, f: () => Promise<void>) {
  const srv = Bun.serve({ port: 0, fetch: handler });
  useEnv(`http://127.0.0.1:${srv.port}`);
  try { await f(); } finally { srv.stop(true); unsetEnv(); }
}

test("liveScope: daemon scope wins and check honors the widened path", async () => {
  await withStub((req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/api/runs/run-1/scope" || req.headers.get("x-factory-token") !== "tok") return new Response("no", { status: 401 });
    return Response.json({ scope: ["src/auth/**", "tests/**"] });
  }, async () => {
    expect(check("Write", { file_path: join(wt, "tests/new.ts") }, liveCtx).allow).toBe(false);
    expect(await liveScope(liveCtx)).toEqual(["src/auth/**", "tests/**"]);
    expect(check("Write", { file_path: join(wt, "tests/new.ts") }, { ...liveCtx, scope: await liveScope(liveCtx) }).allow).toBe(true);
  });
});

test("liveScope: unreachable daemon falls back to env scope", async () => {
  useEnv("http://127.0.0.1:1");
  try { expect(await liveScope(liveCtx)).toEqual(["src/auth/**"]); } finally { unsetEnv(); }
});

test("liveScope: 401 falls back to env scope", async () => {
  await withStub(() => new Response("no", { status: 401 }), async () => {
    expect(await liveScope(liveCtx)).toEqual(["src/auth/**"]);
  });
});

test("liveScope: invalid JSON falls back to env scope", async () => {
  await withStub(() => new Response("<html>not json</html>"), async () => {
    expect(await liveScope(liveCtx)).toEqual(["src/auth/**"]);
  });
});
