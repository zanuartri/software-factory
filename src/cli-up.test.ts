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
