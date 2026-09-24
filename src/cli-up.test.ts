import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = () => { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return String(p); };

test("worker CLI (FACTORY_RUN_ID) never starts a daemon", () => {
  const home = mkdtempSync(join(tmpdir(), "factory-up-"));
  const p = Bun.spawnSync({
    cmd: ["bun", join(import.meta.dir, "cli.ts"), "status"],
    env: { ...process.env, FACTORY_RUN_ID: "test", FACTORY_PORT: freePort(), FACTORY_HOME: home },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const log = p.stderr.toString() + p.stdout.toString();
  expect(p.exitCode).toBe(1);
  expect(log).toContain("workers must not start one");
  expect(existsSync(join(home, "daemon.log"))).toBe(false);
});

test("up() diagnoses a port held by a non-daemon listener", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-up-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); // accepts TCP, never answers HTTP
  try {
    const env: Record<string, string | undefined> = { ...process.env, FACTORY_PORT: String(listener.port), FACTORY_HOME: home };
    delete env.FACTORY_RUN_ID;
    const t0 = performance.now();
    const p = Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "cli.ts"), "status"],
      env, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const elapsed = performance.now() - t0;
    const log = p.stderr.toString() + p.stdout.toString();
    expect(p.exitCode).toBe(1);
    expect(log).toContain("is in use but the factory daemon is not answering");
    expect(log).toContain(process.platform === "win32" ? `netstat -ano | findstr :${listener.port}` : `lsof -i :${listener.port}`);
    expect(log).toContain("and stop the process holding it");
    expect(elapsed).toBeLessThan(30000);
  } finally {
    listener.stop(true);
  }
}, 40000); // budget: worst case ~17.5s (3s+0.5s+3s checks + ~10s poll + Bun startup), regression ~130s — 30s bound catches it

test("up() starts a daemon and reports it", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-up-"));
  const port = freePort();
  const env: Record<string, string | undefined> = { ...process.env, FACTORY_PORT: port, FACTORY_HOME: home };
  delete env.FACTORY_RUN_ID;
  try {
    const p = Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "cli.ts"), "up"],
      env, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain(`factoryd up at http://127.0.0.1:${port}`);
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => {});
  }
}, 30000);
