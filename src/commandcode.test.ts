import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "./adapters";

/** The mcp add/remove spawns resolve instantly; the -p turn spawn is recorded but never emits. */
test("commandcode re-registers the factory MCP before every turn, first and resumed alike", async () => {
  const realSpawn = Bun.spawn;
  const seen: string[][] = [];
  (Bun as any).spawn = (args: string[]) => {
    seen.push(args);
    return { pid: 0, exitCode: null, stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0) };
  };
  try {
    const dir = mkdtempSync(join(tmpdir(), "factory-cc-"));
    const handle = await ADAPTERS.commandcode.start({
      runId: "r-cc", role: "worker", cwd: dir, runDir: dir, prompt: "turn one", mcpUrl: "http://127.0.0.1:9/mcp", env: {}, onEvent: () => {},
    });
    await handle.send("turn two");
    const kind = (a: string[]) => (a.includes("-p") ? "turn" : a.includes("remove") ? "remove" : a.includes("add") ? "add" : "other");
    expect(seen.map(kind)).toEqual(["remove", "add", "turn", "remove", "add", "turn"]); // registration precedes each turn process
    expect(seen[1]).toContain("factory"); // mcp add ... factory <mcpUrl>
    expect(seen[1]).toContain("http://127.0.0.1:9/mcp");
  } finally {
    (Bun as any).spawn = realSpawn;
  }
});
