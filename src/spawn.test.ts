import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;

/** Raw text of every `Bun.spawn(`/`Bun.spawnSync(` call: from its `(` to the matching `)`. */
function spawnCalls(src: string) {
  return [...src.matchAll(/Bun\.spawn(?:Sync)?\(/g)].map((m) => {
    let depth = 0, i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    return src.slice(m.index!, i + 1);
  });
}

test("background spawns hide their windows", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const calls: string[] = [];
  for (const f of files) {
    if (f === "folder-pick.ts") continue; // the Windows folder dialog must remain visible
    for (const call of spawnCalls(readFileSync(join(dir, f), "utf8"))) {
      if (f === "cli.ts" && call.includes('"start"')) continue; // `factory ui` opens the browser on purpose
      calls.push(`${f}: ${call}`);
    }
  }
  expect(calls.length).toBeGreaterThan(10); // a broken matcher must not pass vacuously
  expect(calls.filter((c) => !c.includes("windowsHide: true"))).toEqual([]);
});
