import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-")); // before the db module opens ~/.factory
const { scopesOverlap, pickReviewer } = await import("./supervisor");
const { DEFAULT_SETTINGS } = await import("./store");

test("scope overlap decides what may run in parallel", () => {
  expect(scopesOverlap(["src/auth/**"], ["src/auth/session.ts"])).toBe(true);
  expect(scopesOverlap(["src/auth"], ["src/auth/x/**"])).toBe(true);
  expect(scopesOverlap(["math.js", "test/**"], ["strings.js", "test/strings.test.js"])).toBe(true); // shared test dir → serialize
  expect(scopesOverlap(["math.js", "test/math.test.js"], ["arr.js", "test/arr.test.js"])).toBe(false);
  expect(scopesOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
});

test("reviewer comes from a different harness when one is enabled", () => {
  const s = structuredClone(DEFAULT_SETTINGS); // claude + pi enabled
  expect(pickReviewer(s, "claude").harness).toBe("pi");
  expect(pickReviewer(s, "pi").harness).toBe("claude");
  s.harnesses.pi.enabled = false;
  expect(pickReviewer(s, "claude")).toEqual({ harness: "claude", model: "opus" }); // same harness, different model
});
