import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "./store";
import type { Harness } from "./db";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-")); // before the db module opens ~/.factory
const { bashPath, doctor, effectiveQuality, scopesOverlap, pickReviewer, pickWorker, reviewerCheck } = await import("./supervisor");
const { DEFAULT_SETTINGS } = await import("./store");
const { db } = await import("./db");

const mkTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "T-1", title: "test", status: "open", priority: "p2", tags: [], depends_on: [], scope_paths: [],
  harness: "any", model: "default", difficulty: "medium", created: "", sections: {}, file: "",
  ...overrides,
});

let outcomeSeq = 0;
/** One worker run + one gate event per outcome, so effectiveQuality's join has real rows to read. */
function gateOutcomes(harness: Harness, model: string, passes: number, fails: number) {
  for (let i = 0; i < passes + fails; i++) {
    const id = `r-${harness}-${model}-${outcomeSeq++}`;
    db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,token,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, "w", "T-1", "worker", harness, model, "done", "tok", Date.now());
    db.query("INSERT INTO events (ws,ticket,run,type,data,ts) VALUES (?,?,?,?,?,?)")
      .run("w", "T-1", id, i < passes ? "gate.passed" : "gate.failed", "{}", Date.now());
  }
}

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

test("effectiveQuality: <60% over >=5 gated runs is one level lower", () => {
  gateOutcomes("claude", "q2of6", 2, 4);
  expect(effectiveQuality("claude:q2of6", 4)).toBe(3);
});

test("effectiveQuality: >=60% keeps the base", () => {
  gateOutcomes("claude", "q4of6", 4, 2);
  expect(effectiveQuality("claude:q4of6", 4)).toBe(4);
});

test("effectiveQuality: below 5 gated runs keeps the base", () => {
  gateOutcomes("claude", "q3of4", 3, 1);
  expect(effectiveQuality("claude:q3of4", 4)).toBe(4);
});

test("effectiveQuality: never drops below 1", () => {
  gateOutcomes("claude", "qzero", 0, 5);
  expect(effectiveQuality("claude:qzero", 1)).toBe(1);
});

test("effectiveQuality: caches the pair's record instead of re-querying", () => {
  expect(effectiveQuality("pi:cached", 3)).toBe(3);
  gateOutcomes("pi", "cached", 0, 6); // would demote, but the pass already read this pair
  expect(effectiveQuality("pi:cached", 3)).toBe(3);
});

test("pickWorker: a demoted pair loses to the next-cheapest qualifying pair", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.opencode.enabled = true;
  s.harnesses.commandcode.enabled = true;
  s.catalog = {
    "commandcode:demoted": { cost: 1, quality: 3, family: "a" },
    "opencode:ok": { cost: 2, quality: 3, family: "b" },
  };
  gateOutcomes("commandcode", "demoted", 2, 4); // 2/6 → effective 2 < medium's 3
  expect(pickWorker(s, mkTicket(), [])).toEqual({ harness: "opencode", model: "ok" });
});

test("pickWorker: an unknown difficulty falls back to medium's minimum", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket({ difficulty: "bogus" as Ticket["difficulty"] }), [])).toEqual({ harness: "commandcode", model: "deepseek" });
});

test("pickReviewer: never comes from the worker's harness when the worker isn't a catalog key", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.catalog = {
    "claude:sonnet": { cost: 5, quality: 4, family: "claude" },
    "claude:opus": { cost: 8, quality: 5, family: "claude" },
  };
  expect(pickReviewer(s, { harness: "claude", model: "not-in-catalog" })).toEqual({ harness: "pi", model: "" });
});

test("reviewerCheck: a same-harness reviewer from a different family passes", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.default_harness = "commandcode";
  s.harnesses.commandcode.enabled = true;
  s.harnesses.commandcode.model = "deepseek/deepseek-v4.1-flash";
  s.catalog = {
    "commandcode:deepseek/deepseek-v4.1-flash": { cost: 1, quality: 3, family: "deepseek" },
    "commandcode:z-ai/glm-5.3-flashx": { cost: 2, quality: 4, family: "glm" },
  };
  expect(reviewerCheck(s)).toEqual({ ok: true, detail: "commandcode/deepseek/deepseek-v4.1-flash → commandcode/z-ai/glm-5.3-flashx (deepseek → glm)" });
});

test("reviewerCheck: a reviewer whose family matches the worker fails, even on another harness", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.pi.enabled = false;
  s.harnesses.commandcode.enabled = true;
  s.reviewer_models.commandcode = "glm";
  s.catalog = {
    "claude:sonnet": { cost: 5, quality: 4, family: "claude" },
    "commandcode:glm": { cost: 1, quality: 5, family: "claude" },
  };
  expect(reviewerCheck(s)).toEqual({ ok: false, detail: "claude/sonnet → commandcode/glm (claude → claude)" });
});

test("reviewerCheck: an empty catalog keeps the harness rule", () => {
  expect(reviewerCheck(structuredClone(DEFAULT_SETTINGS))).toEqual({ ok: true, detail: "claude → pi" });
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.pi.enabled = false;
  expect(reviewerCheck(s)).toEqual({ ok: false, detail: "claude → claude/opus" });
});

test("doctor's bin:bash check points at the bash the gate actually runs", () => {
  const c = doctor().find((x) => x.name === "bin:bash")!;
  expect(c.detail).not.toMatch(/\\windows\\system32\\/i);
  if (process.platform === "win32") {
    expect(c.ok).toBe(true);
    expect(c.detail).toBe(bashPath());
  }
});
