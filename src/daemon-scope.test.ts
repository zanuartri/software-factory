import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-scope-")); // before the db module opens it
const { db, HOME } = await import("./db");
const { scopeFor } = await import("./guard");

// reads and shell calls never consult ctx.scope, so they must not pay for a daemon round trip
test("scopeFor only fetches live scope for write tools", async () => {
  let hits = 0;
  const stub = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/scope")) { hits++; return Response.json({ scope: ["live/a.ts"] }); }
      return new Response("not found", { status: 404 });
    },
  });
  const saved = { url: process.env.FACTORY_URL, run: process.env.FACTORY_RUN_ID };
  process.env.FACTORY_URL = `http://127.0.0.1:${stub.port}`;
  process.env.FACTORY_RUN_ID = "r1";
  try {
    const ctx = { worktree: "C:/wt", scope: ["spawn/a.ts"], role: "worker" as const };
    expect(await scopeFor("read", ctx)).toEqual(["spawn/a.ts"]);
    expect(await scopeFor("bash", ctx)).toEqual(["spawn/a.ts"]);
    expect(hits).toBe(0);
    expect(await scopeFor("write", ctx)).toEqual(["live/a.ts"]);
    expect(hits).toBe(1);
  } finally {
    stub.stop(true);
    if (saved.url === undefined) delete process.env.FACTORY_URL; else process.env.FACTORY_URL = saved.url;
    if (saved.run === undefined) delete process.env.FACTORY_RUN_ID; else process.env.FACTORY_RUN_ID = saved.run;
  }
});

// spawn daemon.ts on a free port; only accept /health when its pid is the process we spawned (other suites run in parallel)
async function startDaemon() {
  const health = async (port: number) =>
    fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<{ pid: number }>, () => null);
  for (let attempt = 0; attempt < 2; attempt++) {
    const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = l.port;
    l.stop(true);
    const p = Bun.spawn(["bun", join(import.meta.dir, "daemon.ts")], {
      env: { ...process.env, FACTORY_PORT: String(port), FACTORY_HOME: HOME }, stdout: "ignore", stderr: "ignore", windowsHide: true,
    });
    for (let i = 0; i < 200; i++) {
      const h = await health(port);
      if (h?.pid === p.pid) return { p, port };
      await Bun.sleep(50);
    }
    p.kill();
  }
  throw new Error("daemon did not come up");
}

test("GET /api/runs/:id/scope is token-checked and returns the ticket's scope_paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-scope-ws-"));
  mkdirSync(join(root, ".factory", "tickets"), { recursive: true });
  writeFileSync(join(root, ".factory", "tickets", "T-1.md"),
    "---\nid: T-1\ntitle: scope test\nstatus: done\npriority: p2\ntags: []\nscope_paths: [src/one.ts, src/two.ts]\n---\n## Goal\nseed\n");
  db.query("INSERT INTO workspaces (id,name,path,created_at) VALUES (?,?,?,?)").run("wscope", "wscope", root, Date.now());
  db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,token,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("rscope", "wscope", "T-1", "worker", "claude", "sonnet", "done", "tok-scope", Date.now());

  const { p, port } = await startDaemon();
  const url = `http://127.0.0.1:${port}/api/runs/rscope/scope`;
  try {
    const noToken = await fetch(url);
    expect(noToken.status).toBe(401);
    const wrong = await fetch(url, { headers: { "x-factory-token": "wrong" } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(url, { headers: { "x-factory-token": "tok-scope" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ scope: ["src/one.ts", "src/two.ts"] });
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => {});
    await Promise.race([p.exited, Bun.sleep(3000)]);
    p.kill();
  }
});
