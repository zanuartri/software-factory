import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFolder, pickFolderCmd } from "./folder-pick";

test("pickFolderCmd: windows powershell with -STA and a FolderBrowserDialog", () => {
  const cmd = pickFolderCmd("win32");
  expect(cmd[0]).toBe("powershell.exe");
  expect(cmd).toContain("-STA");
  expect(cmd.join(" ")).toContain("FolderBrowserDialog");
  expect(cmd.join(" ")).toContain("SelectedPath");
});

test("pickFolderCmd: mac uses osascript choose folder", () => {
  const cmd = pickFolderCmd("darwin");
  expect(cmd[0]).toBe("osascript");
  expect(cmd.join(" ")).toContain("POSIX path of (choose folder)");
});

test("pickFolderCmd: linux uses zenity", () => {
  const cmd = pickFolderCmd("linux");
  expect(cmd[0]).toBe("zenity");
  expect(cmd).toContain("--directory");
});

test("pickFolder: runs the command for this platform", async () => {
  let seen: string[] = [];
  const picked = await pickFolder(async (cmd) => { seen = cmd; return { stdout: "/tmp/somewhere", exitCode: 0 }; });
  expect(seen).toEqual(pickFolderCmd(process.platform));
  expect(picked).toBe("/tmp/somewhere");
});

test("pickFolder: null when the user cancels or the dialog prints nothing", async () => {
  expect(await pickFolder(async () => ({ stdout: "", exitCode: 0 }))).toBeNull();
  expect(await pickFolder(async () => ({ stdout: "  \r\n", exitCode: 0 }))).toBeNull();
  expect(await pickFolder(async () => ({ stdout: "/tmp/x", exitCode: 1 }))).toBeNull();
});

test("pickFolder: trims the picked path", async () => {
  expect(await pickFolder(async () => ({ stdout: " C:\\Users\\me\\my repo \r\n", exitCode: 0 }))).toBe("C:\\Users\\me\\my repo");
});

test("pickFolder: a missing dialog binary names the fix", async () => {
  const enoent = Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" });
  expect(pickFolder(async () => { throw enoent; })).rejects.toThrow("no folder dialog available (install zenity)");
});

type WsRow = { id: string; path: string; counts: Record<string, number> };
const freePort = () => { const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = l.port; l.stop(true); return p; };

test("GET /api/workspaces counts tickets per status and survives a missing repo", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-pick-home-"));
  const repo = mkdtempSync(join(tmpdir(), "factory-pick-repo-"));
  const tickets = join(repo, ".factory", "tickets");
  mkdirSync(tickets, { recursive: true });
  const ticket = (id: string, status: string) =>
    writeFileSync(join(tickets, `${id}-x.md`), `---\nid: ${id}\ntitle: x\nstatus: ${status}\npriority: p2\n---\n\n## Goal\nG\n`);
  ticket("T-001", "open"); ticket("T-002", "done"); ticket("T-003", "done"); ticket("T-004", "draft");
  // a workspace row whose repo is gone: written straight into the daemon's db so no watcher is attached to the removed dir
  const seeded = new Database(join(home, "factory.db"), { create: true });
  seeded.exec("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, manager TEXT, manager_seen INTEGER, created_at INTEGER NOT NULL)");
  seeded.query("INSERT INTO workspaces (id,name,path,created_at) VALUES (?,?,?,?)").run("gone", "gone", join(home, "vanished-repo"), Date.now());
  seeded.close();

  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore", windowsHide: true });
  expect(init.exitCode).toBe(0);
  const port = freePort();
  const p = Bun.spawn(["bun", join(import.meta.dir, "daemon.ts")], {
    env: { ...process.env, FACTORY_PORT: String(port), FACTORY_HOME: home }, stdout: "ignore", stderr: "pipe", windowsHide: true,
  });
  const api = (method: string, path: string, payload?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }) });
  try {
    let up = false;
    // cross-process readiness: the child's clock can't be faked here, so poll /health (the daemon-startup suite does the same)
    for (let i = 0; i < 300 && !up; i++) {
      up = await api("GET", "/health").then((r) => r.json() as Promise<{ pid: number }>).then((h) => h.pid === p.pid, () => false);
      if (!up) await Bun.sleep(50);
    }
    expect(up).toBe(true);
    const w = (await (await api("POST", "/api/workspaces", { path: repo })).json()) as { id: string };

    const res = await api("GET", "/api/workspaces");
    expect(res.status).toBe(200);
    const list = (await res.json()) as WsRow[]; // daemon list response shape, asserted by this test
    const counts = (id: string) => list.find((r) => r.id === id)?.counts;
    expect(list.length).toBe(2);
    expect(counts(w.id)).toEqual({ draft: 1, done: 2, open: 1 });
    expect(counts("gone")).toEqual({});
  } finally {
    await api("POST", "/api/shutdown").catch(() => {});
    await Promise.race([p.exited, Bun.sleep(3000)]);
    p.kill();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}, 30000);
