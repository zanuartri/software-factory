import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = () => { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return String(p); };

for (const bad of ["-5", "0", "abc"]) test(`factory wait --timeout ${bad} dies before starting a daemon`, () => {
  const home = mkdtempSync(join(tmpdir(), "factory-wait-"));
  const p = Bun.spawnSync({
    cmd: ["bun", join(import.meta.dir, "cli.ts"), "wait", "--timeout", bad],
    env: { ...process.env, FACTORY_PORT: freePort(), FACTORY_HOME: home },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const log = p.stderr.toString() + p.stdout.toString();
  expect(p.exitCode).toBe(1);
  expect(log).toContain("--timeout must be");
  expect(existsSync(join(home, "daemon.log"))).toBe(false);
});

test("factory wait long-poll stays under Bun's ~300s fetch timeout", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  const def = src.match(/flags\.timeout === undefined \? (\d+)/);
  const clamp = src.match(/timeout=\$\{Math\.min\([^,]+, (\d+)\)\}/);
  expect(def).not.toBeNull();
  expect(clamp).not.toBeNull();
  expect(Math.max(Number(def![1]), Number(clamp![1]))).toBeLessThanOrEqual(240);
});
