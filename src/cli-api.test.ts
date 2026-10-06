import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("GET /api/ws/:ws/tickets attaches the latest worker run (harness, model) or null", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-runs-home-")), repo = mkdtempSync(join(tmpdir(), "factory-runs-repo-"));
  const tickets = join(repo, ".factory", "tickets");
  mkdirSync(tickets, { recursive: true });
  for (const id of ["T-001", "T-002", "T-003"]) writeFileSync(join(tickets, `${id}-x.md`), `---\nid: ${id}\ntitle: x\nstatus: open\npriority: p2\n---\n\n## Goal\nG\n`);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode).toBe(0);
  const port = (() => { const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = l.port; l.stop(true); return p; })();
  const p = Bun.spawn(["bun", join(import.meta.dir, "daemon.ts")], { env: { ...process.env, FACTORY_PORT: String(port), FACTORY_HOME: home }, stdout: "ignore", stderr: "pipe", windowsHide: true });
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) {
      up = await get("/health").then((r) => r.json() as Promise<{ pid: number }>).then((h) => h.pid === p.pid, () => false);
      if (!up) await Bun.sleep(50);
    }
    expect(up).toBe(true);
    const w = (await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo }) })).json()) as { id: string };
    const seeded = new Database(join(home, "factory.db")); // own connection: importing ./db here would clash with the suites that share this process
    const run = (id: string, ws: string, ticket: string, role: string, harness: string, model: string | null, at: number) =>
      seeded.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,token,started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, ws, ticket, role, harness, model, "done", "tok", at);
    run("r1", w.id, "T-001", "worker", "claude", "sonnet", 100);
    run("r2", w.id, "T-001", "worker", "omp", null, 200); // the retry on another harness is the one shown
    run("r3", w.id, "T-001", "reviewer", "commandcode", "x", 300); // a later reviewer run never counts
    run("r4", w.id, "T-002", "reviewer", "claude", "opus", 100); // reviewer only: no worker run
    run("r5", "other", "T-003", "worker", "claude", "haiku", 100); // another workspace
    seeded.close();
    const list = (await (await get(`/api/ws/${w.id}/tickets`)).json()) as { id: string; run: unknown }[];
    expect(Object.fromEntries(list.map((t) => [t.id, t.run]))).toEqual({ "T-001": { harness: "omp", model: null }, "T-002": null, "T-003": null });
    const one = async (id: string) => ((await (await get(`/api/ws/${w.id}/tickets/${id}`)).json()) as { run: unknown }).run;
    expect([await one("T-001"), await one("T-002")]).toEqual([{ harness: "omp", model: null }, null]);
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => {});
    await Promise.race([p.exited, Bun.sleep(3000)]);
    p.kill();
  }
}, 30000);
