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
    const p = Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "cli.ts"), "status"],
      env, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const log = p.stderr.toString() + p.stdout.toString();
    expect(p.exitCode).toBe(1);
    expect(log).toContain("is in use but the factory daemon is not answering");
    expect(log).toContain(process.platform === "win32" ? `netstat -ano | findstr :${listener.port}` : `lsof -i :${listener.port}`);
    expect(log).toContain("and stop the process holding it");
  } finally {
    listener.stop(true);
  }
}, 180000); // up() polls a silent listener 40x, and each /health probe eats its full 3s timeout
