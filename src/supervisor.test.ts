import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "./store";
import type { Harness } from "./db";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-")); // before the db module opens ~/.factory
const { bashPath, doctor, effectiveQuality, ownFault, scopesOverlap, pickReviewer, pickWorker, reviewerCheck } = await import("./supervisor");
const { DEFAULT_SETTINGS } = await import("./store");
const { db } = await import("./db");

const mkTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "T-1", title: "test", status: "open", priority: "p2", tags: [], depends_on: [], scope_paths: [],
  harness: "any", model: "default", difficulty: "medium", created: "", sections: {}, file: "",
  ...overrides,
});

let outcomeSeq = 0;
/** One worker run + one gate event per outcome, so effectiveQuality's join has real rows to read.
 *  `failData` is the gate.failed payload; the default `{}` mimics rows written before ownFault existed. */
function gateOutcomes(harness: Harness, model: string, passes: number, fails: number, failData: Record<string, unknown> = {}) {
  for (let i = 0; i < passes + fails; i++) {
    const id = `r-${harness}-${model}-${outcomeSeq++}`;
    db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,token,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, "w", "T-1", "worker", harness, model, "done", "tok", Date.now());
    db.query("INSERT INTO events (ws,ticket,run,type,data,ts) VALUES (?,?,?,?,?,?)")
      .run("w", "T-1", id, i < passes ? "gate.passed" : "gate.failed", JSON.stringify(i < passes ? {} : failData), Date.now());
  }
}

let stallSeq = 0;
/** One worker run + one stall/blocked event per outcome, matching blockTicket's shape: reason inside `data`. */
function stallOutcomes(harness: Harness, model: string, type: "run.timebox" | "ticket.blocked", n: number, reason = "") {
  for (let i = 0; i < n; i++) {
    const id = `r-${harness}-${model}-s${stallSeq++}`;
    db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,token,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, "w", "T-1", "worker", harness, model, "done", "tok", Date.now());
    db.query("INSERT INTO events (ws,ticket,run,type,data,ts) VALUES (?,?,?,?,?,?)")
      .run("w", "T-1", id, type, JSON.stringify({ minutes: 45, reason }), Date.now());
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
  const s = structuredClone(DEFAULT_SETTINGS); // claude + omp enabled
  expect(pickReviewer(s, { harness: "claude", model: "sonnet" }).harness).toBe("omp");
  expect(pickReviewer(s, { harness: "omp", model: "" }).harness).toBe("claude");
  s.harnesses.omp.enabled = false;
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
  "omp:mimo": { cost: 2, quality: 3, family: "mimo" },
  "omp:hy3": { cost: 2, quality: 4, family: "hy3", caps: ["ui"] },
  "claude:sonnet": { cost: 5, quality: 4, family: "claude" },
  "claude:opus": { cost: 8, quality: 5, family: "claude" },
};
function settingsWithCatalog() {
  const s = structuredClone(DEFAULT_SETTINGS);
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
  expect(pickWorker(s, mkTicket({ difficulty: "high" }), [])).toEqual({ harness: "omp", model: "hy3" });
});

test("pickWorker: attempt 2 escalates the minimum quality", () => {
  const s = settingsWithCatalog();
  const t = mkTicket({ difficulty: "low" });
  expect(pickWorker(s, t, [], 1)).toEqual({ harness: "commandcode", model: "cheapo" });
  expect(pickWorker(s, t, [], 2)).toEqual({ harness: "commandcode", model: "deepseek" });
});

test("pickWorker: a ui tag requires the ui cap", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket({ tags: ["ui"] }), [])).toEqual({ harness: "omp", model: "hy3" });
});

test("pickWorker: a high-difficulty retry (minQuality 5) takes the best free pair, not the default harness", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.commandcode.enabled = true;
  s.catalog = {
    "commandcode:retry-cheap": { cost: 1, quality: 3, family: "a" },
    "omp:retry-best": { cost: 9, quality: 4, family: "b" },
  };
  expect(pickWorker(s, mkTicket({ difficulty: "high" }), [], 2)).toEqual({ harness: "omp", model: "retry-best" });
});

test("pickWorker: the quality fallback never picks a max:0 (reviewer-only) harness", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.commandcode.enabled = true;
  (s.harnesses.omp as any).max = 0; // highest quality, but not free
  s.catalog = {
    "omp:max0-best": { cost: 1, quality: 5, family: "a" },
    "commandcode:fallback-ok": { cost: 1, quality: 2, family: "b" },
  };
  expect(pickWorker(s, mkTicket({ difficulty: "high" }), [], 2)).toEqual({ harness: "commandcode", model: "fallback-ok" });
});

test("pickWorker: a ui tag falls back to the default harness when no free pair has the ui cap", () => {
  const s = settingsWithCatalog();
  (s.harnesses.omp as any).max = 0; // the only ui-capable pair sits on a reviewer-only harness
  expect(pickWorker(s, mkTicket({ tags: ["ui"] }), [])).toEqual({ harness: "claude", model: "sonnet" });
});

test("pickWorker: an explicit ticket harness/model wins", () => {
  const s = settingsWithCatalog();
  expect(pickWorker(s, mkTicket({ harness: "claude", model: "opus" }), [])).toEqual({ harness: "claude", model: "opus" });
});

test("pickWorker: two equal-cost pairs alternate across calls", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.commandcode.enabled = true;
  s.catalog = { "omp:tieA": { cost: 3, quality: 3, family: "a" }, "commandcode:tieB": { cost: 3, quality: 3, family: "b" } };
  const t = mkTicket();
  expect(pickWorker(s, t, [])?.harness).toBe("omp");
  expect(pickWorker(s, t, [])?.harness).toBe("commandcode");
  expect(pickWorker(s, t, [])?.harness).toBe("omp");
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
  expect(effectiveQuality("omp:cached", 3)).toBe(3);
  gateOutcomes("omp", "cached", 0, 6); // would demote, but the pass already read this pair
  expect(effectiveQuality("omp:cached", 3)).toBe(3);
});

test("effectiveQuality: hitting the timebox counts as a failure", () => {
  gateOutcomes("claude", "stall-timebox", 3, 0);
  stallOutcomes("claude", "stall-timebox", "run.timebox", 3);
  expect(effectiveQuality("claude:stall-timebox", 4)).toBe(3);
});

test("effectiveQuality: stopping twice without factory_submit counts as a failure", () => {
  gateOutcomes("claude", "stall-submit", 3, 0);
  stallOutcomes("claude", "stall-submit", "ticket.blocked", 3, "worker stopped twice without factory_submit");
  expect(effectiveQuality("claude:stall-submit", 4)).toBe(3);
});

test("effectiveQuality: a neutral block (worker process exited) keeps the base", () => {
  gateOutcomes("claude", "stall-neutral", 5, 0);
  stallOutcomes("claude", "stall-neutral", "ticket.blocked", 1, "worker process exited (code 1) — resume with `factory tell T-1`");
  expect(effectiveQuality("claude:stall-neutral", 4)).toBe(4);
});

test("effectiveQuality: neutral blocks do not pad the outcome count", () => {
  gateOutcomes("claude", "stall-neutral-count", 3, 0);
  stallOutcomes("claude", "stall-neutral-count", "ticket.blocked", 3, "worker process exited (code 1)");
  expect(effectiveQuality("claude:stall-neutral-count", 4)).toBe(4); // 3 outcomes, below the >=5 minimum
});

test("ownFault: a verify failure naming an in-scope file is the worker's fault", () => {
  expect(ownFault(["src/supervisor.ts"], ["src/supervisor.ts:129:1 - error TS2322: Type 'x' is not assignable"], false)).toBe(true);
  expect(ownFault(["src/**"], ["src\\a.ts(3,5): error TS1005: ';' expected"], false)).toBe(true);
});

test("ownFault: a verify failure that names no in-scope file is not the worker's fault", () => {
  expect(ownFault(["src/supervisor.ts"], ["execvpe(/bin/bash) failed: No such file or directory"], false)).toBe(false);
  expect(ownFault(["src/supervisor.ts"], ["test/cli-wait.test.ts timed out after 20s"], false)).toBe(false);
});

test("ownFault: structural or reviewer findings are the worker's fault even with a clean verify log", () => {
  expect(ownFault(["src/supervisor.ts"], [""], true)).toBe(true);
  expect(ownFault([], [], true)).toBe(true);
});

test("effectiveQuality: gate failures outside the worker's scope keep the base", () => {
  gateOutcomes("claude", "infra-fails", 2, 0);
  gateOutcomes("claude", "infra-fails", 0, 4, { ownFault: false, findings: ["Verify failed: `bun test` exited 1"] });
  expect(effectiveQuality("claude:infra-fails", 4)).toBe(4); // only the 2 passes count, below the >=5 minimum
});

test("effectiveQuality: the same counts with ownFault:true still demote", () => {
  gateOutcomes("claude", "own-fails", 2, 0);
  gateOutcomes("claude", "own-fails", 0, 4, { ownFault: true, findings: ["Verify failed: `bun test` exited 1"] });
  expect(effectiveQuality("claude:own-fails", 4)).toBe(3); // 2/6 = 33%
});

test("effectiveQuality: legacy gate.failed rows without ownFault still count", () => {
  gateOutcomes("claude", "legacy-fails", 2, 3); // pre-ownFault payloads: data "{}"
  gateOutcomes("claude", "legacy-fails", 0, 5, { ownFault: false });
  expect(effectiveQuality("claude:legacy-fails", 4)).toBe(3); // 2/5 = 40%
});

test("pickWorker: a demoted pair loses to the next-cheapest qualifying pair", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.commandcode.enabled = true;
  s.catalog = {
    "commandcode:demoted": { cost: 1, quality: 3, family: "a" },
    "omp:ok": { cost: 2, quality: 3, family: "b" },
  };
  gateOutcomes("commandcode", "demoted", 2, 4); // 2/6 → effective 2 < medium's 3
  expect(pickWorker(s, mkTicket(), [])).toEqual({ harness: "omp", model: "ok" });
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
  expect(pickReviewer(s, { harness: "claude", model: "not-in-catalog" })).toEqual({ harness: "omp", model: DEFAULT_SETTINGS.harnesses.omp.model });
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
  s.harnesses.omp.enabled = false;
  s.harnesses.commandcode.enabled = true;
  s.reviewer_models.commandcode = "glm";
  s.catalog = {
    "claude:sonnet": { cost: 5, quality: 4, family: "claude" },
    "commandcode:glm": { cost: 1, quality: 5, family: "claude" },
  };
  expect(reviewerCheck(s)).toEqual({ ok: false, detail: "claude/sonnet → commandcode/glm (claude → claude)" });
});

test("reviewerCheck: an empty catalog keeps the harness rule", () => {
  expect(reviewerCheck(structuredClone(DEFAULT_SETTINGS))).toEqual({ ok: true, detail: `claude → omp/${DEFAULT_SETTINGS.harnesses.omp.model}` });
  const s = structuredClone(DEFAULT_SETTINGS);
  s.harnesses.omp.enabled = false;
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

test("doctor: the model catalog line names where the catalog came from", () => {
  const globalFile = join(process.env.FACTORY_HOME!, "catalog.json");
  const cat = (id: string, settings: object) => {
    const root = mkdtempSync(join(tmpdir(), `factory-ws-${id}-`));
    mkdirSync(join(root, ".factory"), { recursive: true });
    writeFileSync(join(root, ".factory", "settings.json"), JSON.stringify(settings));
    db.query("INSERT INTO workspaces (id,name,path,created_at) VALUES (?,?,?,?)").run(id, id, root, Date.now());
    const c = () => doctor(id).find((x) => x.name === `${id}: model catalog`)!;
    return c;
  };

  writeFileSync(globalFile, JSON.stringify({ "omp:hy3": { cost: 2, quality: 5, family: "omp" }, "commandcode:deepseek": { cost: 1, quality: 4, family: "cc" } }));
  expect(cat("cat-global", {})()).toEqual({ name: "cat-global: model catalog", ok: true, detail: "global (2 entries)" });
  expect(cat("cat-repo", { catalog: { "claude:opus": { cost: 9, quality: 5, family: "claude" } } })().detail).toBe("repo (1 entries)");
  rmSync(globalFile, { force: true });
  expect(cat("cat-none", { catalog: {} })()).toEqual({ name: "cat-none: model catalog", ok: true, detail: "none — routing uses default_harness" });
});

test("pickReviewer: a pinned reviewer harness + model wins over the cross-family pick", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.reviewer = { harness: "commandcode", model: "z-ai/glm-5.3-flashx" };
  s.harnesses.commandcode.enabled = true;
  expect(pickReviewer(s, { harness: "claude", model: "sonnet" })).toEqual({ harness: "commandcode", model: "z-ai/glm-5.3-flashx" });
  s.reviewer.model = ""; // no model → the reviewer_models / harness default
  expect(pickReviewer(s, { harness: "claude", model: "sonnet" }).harness).toBe("commandcode");
  s.harnesses.commandcode.enabled = false; // a pin on a disabled harness falls back to auto
  expect(pickReviewer(s, { harness: "claude", model: "sonnet" }).harness).toBe("omp");
});
