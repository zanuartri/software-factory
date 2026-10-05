import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("status waits through a delayed daemon reply without TimeoutError", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-api-"));
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/health") return Response.json({ pid: 1 });
      if (p === "/api/workspaces") { await Bun.sleep(1000); return Response.json([{ id: "t1", path: root }]); }
      if (p === "/api/ws/t1") return Response.json({ name: "stub", settings: { base_branch: "main", max_workers: 1 }, plan: null });
      if (p === "/api/ws/t1/tickets" || p === "/api/ws/t1/runs" || p === "/api/ws/t1/asks") return Response.json([]);
      return Response.json({ error: `no stub for ${p}` }, { status: 404 });
    },
  });
  try {
    const p = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "cli.ts"), "status"],
      cwd: root,
      env: { ...process.env, FACTORY_RUN_ID: "test", FACTORY_PORT: String(srv.port), FACTORY_HOME: home },
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const log = stderr + stdout;
    expect(code).toBe(0);
    expect(log).not.toContain("TimeoutError");
    expect(log).not.toContain("timed out");
    expect(log).toContain("stub  base=main");
  } finally {
    srv.stop(true);
  }
}, 30000);

test("api()'s fetch disables Bun's idle timeout", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  const api = src.match(/async function api\([\s\S]*?\n\}/)?.[0];
  expect(api).not.toBeNull();
  expect(api!).toContain("timeout: false");
});

/** Runs the CLI against a stub daemon; `seen` collects every request the stub received. */
async function viaStub(args: string[], handler: (p: string, req: Request, seen: { method: string; path: string; body?: any }[]) => Response | Promise<Response>) {
  const home = mkdtempSync(join(tmpdir(), "factory-stub-"));
  const seen: { method: string; path: string; body?: any }[] = [];
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req) => {
      const u = new URL(req.url), p = u.pathname + u.search;
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      seen.push({ method: req.method, path: p, body });
      if (u.pathname === "/health") return Response.json({ pid: 1 });
      if (u.pathname === "/api/workspaces") return Response.json([{ id: "t1", path: root }]);
      return handler(p, req, seen);
    },
  });
  try {
    const proc = Bun.spawn({ cmd: ["bun", join(import.meta.dir, "cli.ts"), ...args], cwd: root, env: { ...process.env, FACTORY_RUN_ID: "test", FACTORY_PORT: String(srv.port), FACTORY_HOME: home }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: stdout + stderr, code, seen };
  } finally { srv.stop(true); }
}

test("ticket new builds a whole brief from flags (acceptance lines get checkboxes)", async () => {
  const r = await viaStub(["ticket", "new", "--title", "add mod", "--goal", "Add mod()", "--acceptance", "exports mod\n- [ ] throws on zero", "--verify", "bun test x", "--scope", "a.js,a.test.js", "--timebox", "20m", "--difficulty", "low", "--depends", "T-1"],
    (p) => Response.json({ id: "T-9", file: "f", brief_errors: [] }));
  expect(r.code).toBe(0);
  const post = r.seen.find((s) => s.method === "POST" && s.path.endsWith("/tickets"))!.body;
  expect(post).toMatchObject({ title: "add mod", scope_paths: ["a.js", "a.test.js"], depends_on: ["T-1"], difficulty: "low" });
  expect(post.sections).toEqual({ Goal: "Add mod()", Acceptance: "- [ ] exports mod\n- [ ] throws on zero", Verify: "bun test x", Timebox: "20m" });
}, 30000);

test("the first `factory wait` starts from now, not from the workspace's history", async () => {
  const r = await viaStub(["wait", "--timeout", "1"], (p) => {
    if (p.startsWith("/api/ws/t1/events")) return Response.json([{ id: 42 }]);
    if (p.startsWith("/api/ws/t1/wait")) return Response.json({ events: [], cursor: 42 });
    return Response.json({ error: p }, { status: 404 });
  });
  expect(r.code).toBe(0);
  expect(r.seen.some((s) => s.path.startsWith("/api/ws/t1/wait?since=42"))).toBe(true);
}, 30000);

test("a typed \n inside a flag value is a line break (shells keep it literal)", async () => {
  const r = await viaStub(["ticket", "new", "--title", "t", "--acceptance", "one\ntwo"], () => Response.json({ id: "T-9", file: "f", brief_errors: [] }));
  const post = r.seen.find((s) => s.method === "POST" && s.path.endsWith("/tickets"))!.body;
  expect(post.sections.Acceptance).toBe("- [ ] one\n- [ ] two");
}, 30000);
