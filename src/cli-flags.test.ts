import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Spawns cli.ts against a stub daemon that captures the last POST body. */
async function run(args: string[]) {
  const seen: { hit?: { path: string; body: any } } = {};
  const home = mkdtempSync(join(tmpdir(), "factory-flags-"));
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/health") return Response.json({ pid: 1 });
      if (p === "/api/workspaces") return Response.json([{ id: "t1", path: root }]);
      seen.hit = { path: p, body: await req.json().catch(() => ({})) };
      return Response.json({ id: "T-9", title: "x" });
    },
  });
  try {
    const env: Record<string, string | undefined> = { ...process.env, FACTORY_PORT: String(srv.port), FACTORY_HOME: home };
    delete env.FACTORY_RUN_ID;
    const p = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "cli.ts"), ...args],
      cwd: root, env, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return { seen: seen.hit, code, stderr };
  } finally {
    srv.stop(true);
  }
}

test("factory tell T-9 --abort \"hello world\" sends the text and abort: true", async () => {
  const { seen, code, stderr } = await run(["tell", "T-9", "--abort", "hello world"]);
  expect(code).toBe(0);
  expect(stderr).not.toContain("factory:");
  expect(seen?.path).toBe("/api/ws/t1/tickets/T-9/tell");
  expect(seen?.body).toEqual({ text: "hello world", abort: true });
}, 30000);

test("factory tell T-9 \"hello\" --abort sends the same shape", async () => {
  const { seen, code } = await run(["tell", "T-9", "hello", "--abort"]);
  expect(code).toBe(0);
  expect(seen?.body).toEqual({ text: "hello", abort: true });
}, 30000);

test("a value flag still consumes the next argument", async () => {
  const { seen, code } = await run(["ticket", "new", "--title", "x y"]);
  expect(code).toBe(0);
  expect(seen?.path).toBe("/api/ws/t1/tickets");
  expect(seen?.body).toEqual({ title: "x y" });
}, 30000);
