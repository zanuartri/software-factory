import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("factory wait long-poll stays under Bun's ~300s fetch timeout", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  expect(src).not.toContain("?? 1800");
  const m = src.match(/timeout=\$\{Math\.min\(Number\(flags\.timeout \?\? (\d+)\), (\d+)\)\}/);
  expect(m).not.toBeNull();
  expect(Math.max(Number(m![1]), Number(m![2]))).toBeLessThan(300);
});
