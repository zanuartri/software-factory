import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "./adapters";

test("omp worker and reviewer disable memory with the factory overlay", async () => {
  const realSpawn = Bun.spawn;
  const seen: string[][] = [];
  Reflect.set(Bun, "spawn", (args: string[]) => {
    seen.push(args);
    return { pid: 0, stdin: { write() {}, flush() {}, end() {} }, stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0) };
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "factory-omp-"));
    for (const role of ["worker", "reviewer"] as const) {
      await ADAPTERS.omp.start({
        runId: `r-${role}`, role, cwd: dir, runDir: dir, prompt: "test", mcpUrl: "http://127.0.0.1:9/mcp", env: {}, onEvent: () => {},
      });
    }
    const overlay = join(process.cwd(), "harness", "omp-factory.yml");
    expect(readFileSync(overlay, "utf8")).toContain("backend: off");
    for (const args of seen) {
      const i = args.indexOf("--config");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1].replace(/\\/g, "/")).toMatch(/harness\/omp-factory\.yml$/);
      expect(args).toContain("--mode");
      expect(args).toContain("rpc");
      expect(args).toContain("--approval-mode");
      expect(args).toContain("yolo");
    }
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("--tools");
  } finally {
    Reflect.set(Bun, "spawn", realSpawn);
  }
});
