import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-startup-")); // before the db module opens it
const { db, HOME } = await import("./db");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const addRunning = (id: string, pid: number | null) =>
  db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,pid,token,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, "w", "T-1", "worker", "claude", "sonnet", "running", pid, "tok", Date.now());
const status = (id: string) => (db.query("SELECT status FROM runs WHERE id=?").get(id) as { status: string }).status;

/** Spawn daemon.ts on a free port and wait for a pid-matched /health. Retries the bind once when another process grabs the port. */
async function startDaemon() {
  let port = 0, up = false;
  let p: ReturnType<typeof Bun.spawn> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (p) { await Promise.race([p.exited, Bun.sleep(3000)]); p.kill(); p = undefined; }
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); // the port may be taken before the daemon binds
    port = free.port;
    free.stop(true);
    p = Bun.spawn(["bun", join(import.meta.dir, "daemon.ts")], {
      env: { ...process.env, FACTORY_PORT: String(port), FACTORY_HOME: HOME }, stdout: "ignore", stderr: "pipe", windowsHide: true,
    });
    const errText = new Response(p.stderr as ReadableStream<Uint8Array>).text();
    for (let i = 0; i < 200 && !up; i++) { up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<{ pid: number }>).then((h) => h.pid === p!.pid, () => false); if (!up) await Bun.sleep(50); }
    if (up) break;
    const err = await Promise.race([errText, Bun.sleep(3000).then(() => "")]);
    if (attempt === 1 || !err.includes("EADDRINUSE")) break;
  }
  return { p: p!, port, up };
}

const stopDaemon = async (port: number, p: ReturnType<typeof Bun.spawn>) => {
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => {});
  await Promise.race([p.exited, Bun.sleep(3000)]);
  p.kill();
};

test("a daemon that cannot bind its port leaves live runs untouched", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const dummy = Bun.spawn(["bun", "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  try {
    for (let i = 0; i < 100 && !alive(dummy.pid); i++) await Bun.sleep(10);
    addRunning("r1", dummy.pid);

    const p = Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "daemon.ts")],
      env: { ...process.env, FACTORY_PORT: String(listener.port), FACTORY_HOME: HOME }, // full-suite runs share one process: later test files have overwritten FACTORY_HOME by now
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });

    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("EADDRINUSE");
    expect(status("r1")).toBe("running");
    expect(alive(dummy.pid)).toBe(true);
  } finally {
    dummy.kill();
    listener.stop(true);
  }
});

test("a daemon that binds its port still recovers stale runs", async () => {
  addRunning("r2", null);
  const { p, port, up } = await startDaemon();
  try {
    expect(up).toBe(true);
    expect(status("r2")).toBe("idle");
  } finally {
    await stopDaemon(port, p);
  }
}, 20000);

test("DELETE /api/workspaces/:id unregisters the workspace but not the repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "factory-del-"));
  Bun.spawnSync(["git", "init", repo]);
  const { p, port, up } = await startDaemon();
  const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  let id = "";
  try {
    expect(up).toBe(true);
    const created = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path: repo }) }).then((r) => r.json() as Promise<{ id: string }>);
    id = created.id;
    expect(created.id).toBeTruthy();
    writeFileSync(join(repo, ".factory", "marker.txt"), "store file");

    expect((await api(`/api/workspaces/${created.id}`, { method: "DELETE" })).status).toBe(200);
    const listed = await api("/api/workspaces").then((r) => r.json() as Promise<{ id: string }[]>);
    expect(listed.some((w) => w.id === created.id)).toBe(false);
    expect(existsSync(join(repo, ".factory", "marker.txt"))).toBe(true); // the repo and its .factory/ survive

    const again = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ path: repo }) }).then((r) => r.json() as Promise<{ id: string }>);
    expect(again.id).toBe(created.id);
    expect((await api(`/api/workspaces/${again.id}`, { method: "DELETE" })).status).toBe(200); // leaves no row pointing at the temp repo
    expect((await api("/api/workspaces", { method: "DELETE" })).status).toBe(404); // only /:id is a route, not the collection
  } finally {
    if (id) await api(`/api/workspaces/${id}`, { method: "DELETE" }).catch(() => {}); // best effort: doctor() chokes on a row whose repo is gone
    await stopDaemon(port, p);
    rmSync(repo, { recursive: true, force: true });
  }
}, 60000);
