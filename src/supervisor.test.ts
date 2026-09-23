import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "./store";
import type { Run } from "./db";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-")); // before the db module opens ~/.factory
const { bashPath, doctor, scopesOverlap, pickReviewer, pickWorker } = await import("./supervisor");
const { DEFAULT_SETTINGS } = await import("./store");

const mkTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "T-1", title: "test", status: "open", priority: "p2", tags: [], depends_on: [], scope_paths: [],
  harness: "any", model: "default", difficulty: "medium", created: "", sections: {}, file: "",
  ...overrides,
});
const mkRun = (overrides: Partial<Run> = {}): Run =>
  ({ id: "r-1", ws: "w", ticket: "T-1", role: "worker", harness: "claude", model: null, status: "running", ...overrides } as Run);

test("scope overlap decides what may run in parallel", () => {
  expect(scopesOverlap(["src/auth/**"], ["src/auth/session.ts"])).toBe(true);
  expect(scopesOverlap(["src/auth"], ["src/auth/x/**"])).toBe(true);
  expect(scopesOverlap(["math.js", "test/**"], ["strings.js", "test/strings.test.js"])).toBe(true); // shared test dir → serialize
  expect(scopesOverlap(["math.js", "test/math.test.js"], ["arr.js", "test/arr.test.js"])).toBe(false);
  expect(scopesOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
});

test("reviewer comes from a different harness when one is enabled", () => {
  const s = structuredClone(DEFAULT_SETTINGS); // claude + pi enabled
  expect(pickReviewer(s, { harness: "claude", model: "sonnet" }).harness).toBe("pi");
  expect(pickReviewer(s, { harness: "pi", model: "" }).harness).toBe("claude");
  s.harnesses.pi.enabled = false;
  expect(pickReviewer(s, { harness: "claude", model: "sonnet" })).toEqual({ harness: "claude", model: "opus" }); // same harness, different model
});

test("bashPath is Git Bash on Windows, never the System32 WSL launcher", () => {
  if (process.platform !== "win32") return void expect(bashPath()).toBe("bash");
  expect(bashPath()).not.toMatch(/\\windows\\system32\\/i);
  expect(existsSync(bashPath())).toBe(true);
});

const CATALOG = {
  "commandcode:cheapo": { cost: 0.5, quality: 2, family: "cheapo" },
  "commandcode:deepseek": { cost: 1, quality: 3, family: "deepseek" },
  "opencode:mimo": { cost: 2, quality: 3, family: "mimo" },
  "pi:hy3": { cost: 2, quality: 4, family: "hy3", caps: ["ui"] },
  "claude:sonnet": { cost: 5, quality: 4, family: "claude" },
  "claude:opus": { cost: 8, quality: 5, family: "claude" },
};
function settingsWithCatalog() {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.opencode.enabled = true;
  s.harnesses.commandcode.enabled = true;
  s.catalog = structuredClone(CATALOG);
  return s;
}

test("pickWorker: the cheapest qualifying pair wins", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket(), [])).toEqual({ harness: "commandcode", model: "deepseek" });
});

test("pickWorker: a high-difficulty ticket skips a cheap quality-3 model", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket({ difficulty: "high" }), [])).toEqual({ harness: "pi", model: "hy3" });
});

test("pickWorker: attempt 2 escalates the minimum quality", () => {
  const s = settingsWithCatalog();
  const t = mkTicket({ difficulty: "low" });
  expect(pickWorker(s, t, [], 1)).toEqual({ harness: "commandcode", model: "cheapo" });
  expect(pickWorker(s, t, [], 2)).toEqual({ harness: "commandcode", model: "deepseek" });
});

test("pickWorker: a ui tag requires the ui cap", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket({ tags: ["ui"] }), [])).toEqual({ harness: "pi", model: "hy3" });
});

test("pickWorker: an explicit ticket harness/model wins", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket({ harness: "claude", model: "opus" }), [])).toEqual({ harness: "claude", model: "opus" });
});

test("pickWorker: two equal-cost pairs alternate across calls", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.opencode.enabled = true;
  s.harnesses.commandcode.enabled = true;
  s.catalog = { "opencode:tieA": { cost: 3, quality: 3, family: "a" }, "commandcode:tieB": { cost: 3, quality: 3, family: "b" } };
  const t = mkTicket();
  expect(pickWorker(s, t, [])?.harness).toBe("opencode");
  expect(pickWorker(s, t, [])?.harness).toBe("commandcode");
  expect(pickWorker(s, t, [])?.harness).toBe("opencode");
});

test("pickWorker: an empty catalog gives today's result", () => {
  const s = structuredClone(DEFAULT_SETTINGS); // catalog: {}
  expect(pickWorker(s, mkTicket(), [])).toEqual({ harness: "claude", model: "sonnet" });
});

test("pickReviewer: the reviewer's family differs from the worker's and its quality is >= 4", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.commandcode.enabled = true;
  s.catalog = {
    "claude:sonnet": { cost: 5, quality: 4, family: "claude" },
    "commandcode:deepseek-v2": { cost: 1, quality: 4, family: "deepseek" },
  };
  const r = pickReviewer(s, { harness: "claude", model: "sonnet" });
  expect(r).toEqual({ harness: "commandcode", model: "deepseek-v2" });
});

test("doctor's bin:bash check points at the bash the gate actually runs", () => {
  const c = doctor().find((x) => x.name === "bin:bash")!;
  expect(c.detail).not.toMatch(/\\windows\\system32\\/i);
  if (process.platform === "win32") {
    expect(c.ok).toBe(true);
    expect(c.detail).toBe(bashPath());
  }
});
