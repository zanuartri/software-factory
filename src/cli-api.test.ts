import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
