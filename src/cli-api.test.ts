import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  for (const id of ["T-001", "T-002", "T-003", "T-004"]) writeFileSync(join(tickets, `${id}-x.md`), `---\nid: ${id}\ntitle: x\nstatus: open\npriority: p2\n---\n\n## Goal\nG\n`);
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
    run("r6", w.id, "T-004", "worker", "claude", "sonnet", 400);
    run("r7", w.id, "T-004", "worker", "omp", "mimo", 400); // same started_at: rowid tiebreak, last insert wins
    seeded.close();
    const list = (await (await get(`/api/ws/${w.id}/tickets`)).json()) as { id: string; run: unknown }[];
    expect(Object.fromEntries(list.map((t) => [t.id, t.run]))).toEqual({ "T-001": { harness: "omp", model: null }, "T-002": null, "T-003": null, "T-004": { harness: "omp", model: "mimo" } });
    const one = async (id: string) => ((await (await get(`/api/ws/${w.id}/tickets/${id}`)).json()) as { run: unknown }).run;
    expect([await one("T-001"), await one("T-002"), await one("T-004")]).toEqual([{ harness: "omp", model: null }, null, { harness: "omp", model: "mimo" }]);
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => {});
    await Promise.race([p.exited, Bun.sleep(3000)]);
    p.kill();
  }
}, 30000);

/** A fake `herdr` CLI on PATH: a .cmd wrapping a bun script. `agent list` fails when FAKE_HERDR=fail; otherwise the list is empty
 *  until `workspace create` runs (the started.txt marker), then it reports one live claude pane with session s1. The pane's
 *  agent_status comes from status.txt ("done" when absent) and every `agent send-keys` is appended to keys.log. */
function fakeHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "factory-herdr-"));
  writeFileSync(join(dir, "fake.ts"), [
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `const marker = join(import.meta.dir, "started.txt");`,
    `const status = join(import.meta.dir, "status.txt");`,
    `const keys = join(import.meta.dir, "keys.log");`,
    `const [cmd, sub] = process.argv.slice(2);`,
    `if (cmd === "workspace") { writeFileSync(marker, "1"); console.log(JSON.stringify({ result: { root_pane: { pane_id: "fake-pane" } } })); }`,
    `else if (cmd === "agent" && sub === "list") {`,
    `  if (process.env.FAKE_HERDR === "fail") { console.error("herdr: daemon not running"); process.exit(1); }`,
    `  const st = existsSync(status) ? readFileSync(status, "utf8").trim() : "done";`,
    `  const agents = existsSync(marker) ? [{ pane_id: "fake-pane", name: "", agent: "claude", agent_status: st, cwd: "", agent_session: { value: "s1" } }] : [];`,
    `  console.log(JSON.stringify({ result: { agents } }));`,
    `}`,
    `else if (cmd === "agent" && sub === "send-keys") appendFileSync(keys, process.argv.slice(5).join(" ") + "\\n");`,
    `else process.exit(0);`,
  ].join("\n") + "\n");
  writeFileSync(join(dir, "herdr.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake.ts" %*\r\n`);
  return { dir, marker: join(dir, "started.txt"), status: join(dir, "status.txt"), keys: join(dir, "keys.log") };
}

/** Spawns daemon.ts against a temp FACTORY_HOME with the fake herdr first on PATH; resolves once its own /health answers. */
async function daemonWithFakeHerdr(extra: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "factory-chat-home-")), fake = fakeHerdr();
  const port = (() => { const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = l.port; l.stop(true); return p; })();
  const p = Bun.spawn(["bun", join(import.meta.dir, "daemon.ts")], {
    env: { ...process.env, FACTORY_RUN_ID: "test", FACTORY_PORT: String(port), FACTORY_HOME: home, HOME: home, USERPROFILE: home, PATH: `${fake.dir};${process.env.PATH}`, ...extra },
    stdout: "ignore", stderr: "pipe", windowsHide: true,
  });
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await get("/health").then((r) => r.json() as Promise<{ pid: number }>).then((h) => h.pid === p.pid, () => false);
    if (!up) await Bun.sleep(50);
  }
  expect(up).toBe(true);
  const stop = async () => { await post("/api/shutdown", {}).catch(() => {}); await Promise.race([p.exited, Bun.sleep(3000)]); p.kill(); };
  return { home, fake, get, post, stop };
}

/** git init + register a temp repo as a workspace; returns its id. */
async function registerRepo(post: (path: string, body: unknown) => Promise<Response>) {
  const repo = mkdtempSync(join(tmpdir(), "factory-chat-repo-"));
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode).toBe(0);
  return (await (await post("/api/workspaces", { path: repo })).json()) as { id: string };
}

test("a failing herdr is not 'no agent': GET chat 503s and chat/start aborts before startClaude", async () => {
  const d = await daemonWithFakeHerdr({ FAKE_HERDR: "fail" });
  try {
    const w = await registerRepo(d.post);
    const chat = await d.get(`/api/ws/${w.id}/chat`);
    expect(chat.status).toBe(503);
    expect(await chat.json()).toEqual({ error: "herdr unavailable" });
    expect((await d.get(`/api/ws/${w.id}/chat`)).status).toBe(503); // every poll gets the same answer
    const start = await d.post(`/api/ws/${w.id}/chat/start`, { resume: false });
    expect(start.status).toBe(400);
    expect(((await start.json()) as { error: string }).error).toContain("daemon not running"); // the list error, not a startClaude error
    expect(existsSync(d.fake.marker)).toBe(false); // startClaude's first act is `workspace create`, which would write the marker
  } finally { await d.stop(); }
}, 30000);

test("no live pane: background tasks clear as done; a started pane reports them again", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const proj = join(d.home, ".claude", "projects", "p"); // readChat scans ~/.claude/projects for <session>.jsonl
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s1.jsonl"), [
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 9", run_in_background: true } }] } },
      { type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "started" }] }, toolUseResult: { backgroundTaskId: "bx1" } },
    ].map((r) => JSON.stringify(r)).join("\n"));
    const w = await registerRepo(d.post);
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    const off = (await (await d.get(`/api/ws/${w.id}/chat`)).json()) as any;
    expect(off.status).toBe("offline");
    expect(off.activity).toEqual({ running: null, background: 0 });
    expect(off.messages.map((m: any) => [m.tool?.name, m.tool?.status])).toEqual([["Bash", "done"]]);
    const start = (await (await d.post(`/api/ws/${w.id}/chat/start`, { resume: false })).json()) as { session: string };
    expect(start.session).toBe("s1");
    expect(existsSync(d.fake.marker)).toBe(true); // a pane really was created
    const live = (await (await d.get(`/api/ws/${w.id}/chat`)).json()) as any;
    expect(live.status).toBe("done"); // the fake pane's agent_status
    expect(live.pane).toBe("fake-pane");
    expect(live.activity).toEqual({ running: null, background: 1 }); // same transcript: the offline mapping copied, never mutated readChat's cache
    expect(live.messages.map((m: any) => [m.tool?.name, m.tool?.status])).toEqual([["Bash", "background"]]);
  } finally { await d.stop(); }
}, 30000);

test("chat/interrupt: no esc on an idle agent, and two at once send only one esc", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const w = await registerRepo(d.post);
    await d.post(`/api/ws/${w.id}/chat/start`, { resume: false }); // creates the fake pane, so managerAgent finds it
    const esc = () => (existsSync(d.fake.keys) ? readFileSync(d.fake.keys, "utf8").trim().split("\n").filter(Boolean) : []);
    const interrupt = () => d.post(`/api/ws/${w.id}/chat/interrupt`, {}).then((r) => r.json());
    expect(await interrupt()).toEqual({ ok: true, skipped: true }); // the fake pane is "done": esc would open the Rewind menu
    expect(esc()).toEqual([]);
    writeFileSync(d.fake.status, "working");
    const both = await Promise.all([interrupt(), interrupt()]); // two interrupts inside the 1s window
    expect(both).toEqual(expect.arrayContaining([{ ok: true }, { ok: true, skipped: true }]));
    expect(esc()).toEqual(["esc"]);
  } finally { await d.stop(); }
}, 30000);

