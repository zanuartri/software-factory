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
    `const nextStatus = join(import.meta.dir, "next-status.txt");`,
    `const nextScreen = join(import.meta.dir, "next-screen.txt");`,
    `const keys = join(import.meta.dir, "keys.log");`,
    `const [cmd, sub] = process.argv.slice(2);`,
    `if (cmd === "workspace") { writeFileSync(marker, "1"); console.log(JSON.stringify({ result: { root_pane: { pane_id: "fake-pane" } } })); }`,
    `else if (cmd === "agent" && sub === "list") {`,
    `  if (process.env.FAKE_HERDR === "fail") { console.error("herdr: daemon not running"); process.exit(1); }`,
    `  const st = existsSync(status) ? readFileSync(status, "utf8").trim() : "done";`,
    `  const name = existsSync(join(import.meta.dir, "name.txt")) ? readFileSync(join(import.meta.dir, "name.txt"), "utf8") : "";`,
    `  const calls = join(import.meta.dir, "list-calls.txt"); writeFileSync(calls, String(Number(existsSync(calls) ? readFileSync(calls, "utf8") : 0) + 1));`,
    `  // Deliberate integration delay keeps concurrent chat requests inside the same in-flight read.`,
    `  if (existsSync(join(import.meta.dir, "slow-list.txt"))) await Bun.sleep(50);`,
    `  const agents = existsSync(marker) ? [{ pane_id: "fake-pane", name, agent: "claude", agent_status: st, cwd: "", agent_session: { value: "s1" } }] : [];`,
    `  console.log(JSON.stringify({ result: { agents } }));`,
    `}`,
    `else if (cmd === "agent" && sub === "read") { const calls = join(import.meta.dir, "screen-calls.txt"); writeFileSync(calls, String(Number(existsSync(calls) ? readFileSync(calls, "utf8") : 0) + 1)); if (existsSync(join(import.meta.dir, "slow-screen.txt"))) await Bun.sleep(50); const screen = join(import.meta.dir, "screen.txt"); console.log(existsSync(screen) ? readFileSync(screen, "utf8") : process.argv.includes("--format") ? "❯ \\x1b[0m\\x1b[2mSuggested next prompt\\x1b[0m" : "❯ Suggested next prompt"); }`,
    `else if (cmd === "agent" && sub === "send-keys") { appendFileSync(keys, process.argv.slice(5).join(" ") + "\\n"); if (process.argv[5] === "esc") { if (existsSync(nextStatus)) writeFileSync(status, readFileSync(nextStatus, "utf8")); if (existsSync(nextScreen)) writeFileSync(join(import.meta.dir, "screen.txt"), readFileSync(nextScreen, "utf8")); } }`,
    `else if (cmd === "agent" && sub === "prompt") appendFileSync(keys, "prompt:" + process.argv.slice(5).join(" ") + "\\n");`,
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
  const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
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
test("GET workspaces reports pane status from one herdr list and degrades failures to null", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const w = await registerRepo(d.post);
    const countFile = join(d.fake.dir, "list-calls.txt");
    writeFileSync(countFile, "0");
    const empty = await d.get("/api/workspaces");
    expect(empty.status).toBe(200);
    expect((await empty.json() as { id: string; manager_status: string | null }[]).find((x) => x.id === w.id)?.manager_status).toBeNull();
    expect(readFileSync(countFile, "utf8")).toBe("1");

    writeFileSync(d.fake.marker, "1"); // simulate a manager pane appearing after the initial empty list
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    writeFileSync(join(d.fake.dir, "status.txt"), "working");
    writeFileSync(countFile, "0");
    const bySession = await d.get("/api/workspaces");
    expect((await bySession.json() as { id: string; manager_status: string | null }[]).find((x) => x.id === w.id)?.manager_status).toBe("working");
    expect(readFileSync(countFile, "utf8")).toBe("1");

    writeFileSync(join(d.fake.dir, "name.txt"), `factory-${w.id}`);
    await d.post(`/api/ws/${w.id}/attach`, { session: "other", force: true });
    writeFileSync(join(d.fake.dir, "status.txt"), "blocked");
    const byName = await d.get("/api/workspaces");
    expect((await byName.json() as { id: string; manager_status: string | null }[]).find((x) => x.id === w.id)?.manager_status).toBe("blocked");
  } finally { await d.stop(); }
}, 30000);

test("GET workspaces returns null manager status when herdr is unavailable", async () => {
  const d = await daemonWithFakeHerdr({ FAKE_HERDR: "fail" });
  try {
    const w = await registerRepo(d.post);
    const res = await d.get("/api/workspaces");
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string; manager_status: string | null }[]).find((x) => x.id === w.id)?.manager_status).toBeNull();
  } finally { await d.stop(); }
}, 30000);

test("a failing herdr is not 'no agent': GET chat 503s and chat/start aborts before startClaude", async () => {
  const d = await daemonWithFakeHerdr({ FAKE_HERDR: "fail" });
  try {
    const w = await registerRepo(d.post);
    const chat = await d.get(`/api/ws/${w.id}/chat`);
    expect(chat.status).toBe(503);
    expect(await chat.json()).toEqual({ error: "herdr unavailable: herdr: daemon not running" });
    expect((await d.get(`/api/ws/${w.id}/chat`)).status).toBe(503); // every poll gets the same answer
    const start = await d.post(`/api/ws/${w.id}/chat/start`, { resume: false });
    expect(start.status).toBe(400);
    expect(((await start.json()) as { error: string }).error).toContain("daemon not running"); // the list error, not a startClaude error
    expect(existsSync(d.fake.marker)).toBe(false); // startClaude's first act is `workspace create`, which would write the marker
  } finally { await d.stop(); }
}, 30000);
test("GET chat for an unknown workspace is a 400", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const res = await d.get("/api/ws/not-a-workspace/chat");
    expect(res.status).toBe(400);
  } finally { await d.stop(); }
}, 30000);
test("chat rejects plain text while the manager is blocked", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const w = await registerRepo(d.post);
    writeFileSync(d.fake.marker, "1");
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    writeFileSync(d.fake.status, "blocked");
    const res = await d.post(`/api/ws/${w.id}/chat`, { text: "change the model" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "manager is waiting for an answer; use /chat/answer" });
    expect(existsSync(d.fake.keys)).toBe(false);
    const answer = await d.post(`/api/ws/${w.id}/chat/answer`, { keys: ["1"], enter: true });
    expect(answer.status).toBe(200);
    expect(readFileSync(d.fake.keys, "utf8")).toBe("1\nenter\n");
    writeFileSync(d.fake.status, "done");
    writeFileSync(join(d.fake.dir, "screen.txt"), "Pick a color?\n❯ 1. Green\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel");
    const promptRes = await d.post(`/api/ws/${w.id}/chat`, { text: "change the model" });
    expect(promptRes.status).toBe(400);
    expect(await promptRes.json()).toEqual({ error: "manager is waiting for an answer; use /chat/answer" });
    expect(readFileSync(d.fake.keys, "utf8")).toBe("1\nenter\n");
  } finally { await d.stop(); }
}, 30000);


test("GET chat returns total, honors limit, caps it at 2000, and varies rev by limit", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const proj = join(d.home, ".claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s1.jsonl"), Array.from({ length: 2001 }, (_, i) =>
      JSON.stringify({ type: "user", uuid: `u${i}`, message: { role: "user", content: `message ${i}` } })).join("\n"));
    const w = await registerRepo(d.post);
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    expect((await d.post(`/api/ws/${w.id}/chat/start`, { resume: false })).status).toBe(200);
    const smallRes = await d.get(`/api/ws/${w.id}/chat?limit=2`);
    const small = await smallRes.json() as { total: number; messages: unknown[]; rev: string; status: string };
    expect(small.status).toBe("done");
    expect(small.total).toBe(2001);
    expect(small.messages).toHaveLength(2);
    const etag = smallRes.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(etag).toHaveLength(45);
    const unchanged = await d.get(`/api/ws/${w.id}/chat?limit=2`, { headers: { "if-none-match": etag! } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(await unchanged.text()).toBe("");
    // This wall-clock wait deliberately verifies that the one-second in-memory chat read cache expires.
    await Bun.sleep(1050);
    writeFileSync(d.fake.status, "working");
    const changedStatusRes = await d.get(`/api/ws/${w.id}/chat?limit=2`, { headers: { "if-none-match": etag! } });
    expect(changedStatusRes.status).toBe(200);
    const changedStatus = await changedStatusRes.json() as { status: string };
    expect(changedStatus.status).toBe("working");
    expect(changedStatusRes.headers.get("etag")).not.toBe(etag);
    writeFileSync(d.fake.status, "done");
    expect((await d.post(`/api/ws/${w.id}/chat`, { text: "refresh chat" })).status).toBe(200);
    const afterSend = await d.get(`/api/ws/${w.id}/chat?limit=2`);
    expect((await afterSend.json() as { status: string }).status).toBe("done");
    const changed = await d.get(`/api/ws/${w.id}/chat?limit=4`, { headers: { "if-none-match": etag! } });
    expect(changed.status).toBe(200);
    const larger = await changed.json() as { total: number; messages: unknown[]; rev: string };
    expect(larger.messages).toHaveLength(4);
    expect(larger.rev).not.toBe(small.rev);
    expect(changed.headers.get("etag")).not.toBe(etag);
    const capped = await (await d.get(`/api/ws/${w.id}/chat?limit=9999`)).json() as { total: number; messages: unknown[] };
    expect(capped.messages).toHaveLength(2000);
    expect(capped.total).toBe(2001);
  } finally { await d.stop(); }
}, 30000);
test("concurrent chat polls share herdr agent-list and screen reads per workspace", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const w = await registerRepo(d.post);
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    expect((await d.post(`/api/ws/${w.id}/chat/start`, { resume: false })).status).toBe(200);
    writeFileSync(join(d.fake.dir, "list-calls.txt"), "0");
    writeFileSync(join(d.fake.dir, "screen-calls.txt"), "0");
    writeFileSync(join(d.fake.dir, "slow-list.txt"), "1");
    writeFileSync(join(d.fake.dir, "slow-screen.txt"), "1");
    const [first, second] = await Promise.all([
      d.get(`/api/ws/${w.id}/chat`),
      d.get(`/api/ws/${w.id}/chat`),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await d.get(`/api/ws/${w.id}/chat`)).status).toBe(200);
    expect(readFileSync(join(d.fake.dir, "list-calls.txt"), "utf8")).toBe("1");
    expect(readFileSync(join(d.fake.dir, "screen-calls.txt"), "utf8")).toBe("1");
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
    expect(off.suggestion).toBeNull();
    expect(off.activity).toEqual({ running: null, background: 0 });
    expect(off.messages.map((m: any) => [m.tool?.name, m.tool?.status])).toEqual([["Bash", "done"]]);
    const start = (await (await d.post(`/api/ws/${w.id}/chat/start`, { resume: false })).json()) as { session: string };
    expect(start.session).toBe("s1");
    expect(existsSync(d.fake.marker)).toBe(true); // a pane really was created
    const live = (await (await d.get(`/api/ws/${w.id}/chat`)).json()) as any;
    expect(live.status).toBe("done"); // the fake pane's agent_status
    expect(live.pane).toBe("fake-pane");
    expect(live.activity).toEqual({ running: null, background: 1 }); // same transcript: the offline mapping copied, never mutated readChat's cache
    expect(live.suggestion).toBe("Suggested next prompt");
    expect(live.messages.map((m: any) => [m.tool?.name, m.tool?.status])).toEqual([["Bash", "background"]]);
    writeFileSync(d.fake.status, "working");
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true }); // manager re-attach invalidates the read memo
    const working = (await (await d.get(`/api/ws/${w.id}/chat`)).json()) as any;
    expect(working.suggestion).toBeNull();
  } finally { await d.stop(); }
}, 30000);
test("GET chat revision changes for prompt focus and agent status, and stays stable otherwise", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const proj = join(d.home, ".claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s1.jsonl"), `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`);
    const w = await registerRepo(d.post);
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    await d.post(`/api/ws/${w.id}/chat/start`, { resume: false });
    writeFileSync(d.fake.status, "blocked");
    const screen = join(d.fake.dir, "screen.txt");
    writeFileSync(screen, "Pick a color?\n❯ 1. Green\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel");
    const getChat = async () => (await d.get(`/api/ws/${w.id}/chat`)).json() as Promise<{ rev: string; prompt: { options: { focused: boolean }[] } }>;
    const first = await getChat();
    expect(first.prompt.options.map((o) => o.focused)).toEqual([true, false]);
    expect((await getChat()).rev).toBe(first.rev);

    writeFileSync(screen, "Pick a color?\n  1. Green\n❯ 2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel");
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    const focused = await getChat();
    expect(focused.prompt.options.map((o) => o.focused)).toEqual([false, true]);
    expect(focused.rev).not.toBe(first.rev);

    writeFileSync(d.fake.status, "working");
    await d.post(`/api/ws/${w.id}/attach`, { session: "s1", force: true });
    expect((await getChat()).rev).not.toBe(focused.rev);
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

test("chat steer rechecks status and dialogs after interrupt before prompting", async () => {
  const d = await daemonWithFakeHerdr({});
  try {
    const w = await registerRepo(d.post);
    await d.post(`/api/ws/${w.id}/chat/start`, { resume: false });
    const send = (text: string) => d.post(`/api/ws/${w.id}/chat`, { text, interrupt: true });
    const keys = () => readFileSync(d.fake.keys, "utf8").trim().split("\n").filter(Boolean);
    writeFileSync(d.fake.status, "working");
    writeFileSync(join(d.fake.dir, "next-status.txt"), "blocked");
    const blocked = await send("blocked prompt");
    expect(blocked.status).toBe(400);
    expect(keys()).toEqual(["esc"]);

    writeFileSync(d.fake.keys, "");
    writeFileSync(d.fake.status, "working");
    writeFileSync(join(d.fake.dir, "next-status.txt"), "done");
    writeFileSync(join(d.fake.dir, "next-screen.txt"), ["Pick a color?", "❯ 1. Green", "  2. Blue", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join(String.fromCharCode(10)));
    const dialog = await send("dialog prompt");
    expect(dialog.status).toBe(400);
    expect(keys()).toEqual(["esc"]);
    expect(await dialog.json()).toEqual({ error: "manager is waiting for an answer; use /chat/answer" });

    writeFileSync(d.fake.keys, "");
    writeFileSync(d.fake.status, "working");
    writeFileSync(join(d.fake.dir, "screen.txt"), "❯ Suggested next prompt");
    writeFileSync(join(d.fake.dir, "next-screen.txt"), "❯ Suggested next prompt");
    const clear = await send("done prompt");
    expect(clear.status).toBe(200);
    expect(keys()).toEqual(["esc", "ctrl+u", "prompt:done prompt"]);
  } finally { await d.stop(); }
}, 30000);
