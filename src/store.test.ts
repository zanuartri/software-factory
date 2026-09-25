import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "factory-store-home-"));
process.env.FACTORY_HOME = home;
const { CATALOG_FROM_GLOBAL, DEFAULT_SETTINGS, loadSettings, readTicket, saveSettings, settingsPatch, updateTicket } = await import("./store");

const CATALOG = {
  "pi:hy3": { cost: 2, quality: 5, family: "pi" },
  "commandcode:deepseek": { cost: 1, quality: 4, family: "cc" },
};
const globalFile = join(home, "catalog.json");
const setGlobal = (text: string | null) => (text === null ? rmSync(globalFile, { force: true }) : writeFileSync(globalFile, text));
/** store.ts reads FACTORY_HOME per call, but another test file may have repointed it by the time we run. */
beforeEach(() => { process.env.FACTORY_HOME = home; });
const mkRepo = (settings?: object) => {
  const repo = mkdtempSync(join(tmpdir(), "factory-store-repo-"));
  if (settings) { mkdirSync(join(repo, ".factory"), { recursive: true }); writeFileSync(join(repo, ".factory", "settings.json"), JSON.stringify(settings)); }
  return repo;
};
const savedRepo = (repo: string) => JSON.parse(readFileSync(join(repo, ".factory", "settings.json"), "utf8"));
/** A ticket file written by hand so the frontmatter can hold the raw form under test (e.g. `attempts: "1"`). */
const ticketFile = (repo: string, id: string, extra = "") => {
  const f = join(repo, ".factory", "tickets", `${id}-x.md`);
  mkdirSync(join(repo, ".factory", "tickets"), { recursive: true });
  writeFileSync(f, `---\nid: ${id}\ntitle: x\nstatus: draft\npriority: p2\n${extra}---\n\n## Goal\nG\n`);
  return f;
};

test("settingsPatch: JSON form still works", () => {
  expect(settingsPatch(DEFAULT_SETTINGS, ['{"max_workers":5}'])).toEqual({ max_workers: 5 });
});

test("settingsPatch: coerces number, boolean, array, string", () => {
  const p = settingsPatch(DEFAULT_SETTINGS, [
    "max_workers=2",
    "auto_merge=false",
    'reviewer_order=["pi","claude"]',
    "default_harness=pi",
  ]);
  expect(p.max_workers).toBe(2);
  expect(p.auto_merge).toBe(false);
  expect(p.reviewer_order).toEqual(["pi", "claude"]);
  expect(p.default_harness).toBe("pi");
});

test("settingsPatch: dotted nested key keeps sibling harness fields", () => {
  const p = settingsPatch(DEFAULT_SETTINGS, ["harnesses.pi.model=foo"]);
  expect(p.harnesses!.pi).toEqual({ enabled: true, model: "foo", models: [] });
  expect(p.harnesses!.claude).toEqual(DEFAULT_SETTINGS.harnesses.claude);
});

test("settingsPatch: multiple pairs touch only their top-level keys", () => {
  const p = settingsPatch(DEFAULT_SETTINGS, ["max_workers=2", "harnesses.pi.model=foo"]);
  expect(Object.keys(p).sort()).toEqual(["harnesses", "max_workers"]);
  expect(p.max_workers).toBe(2);
  expect(p.harnesses!.pi.model).toBe("foo");
});

test("settingsPatch: array field accepts PowerShell-stripped bracket syntax", () => {
  const p = settingsPatch(DEFAULT_SETTINGS, ["reviewer_order=[claude,pi]"]);
  expect(p.reviewer_order).toEqual(["claude", "pi"]);
});

test("settingsPatch: array field accepts bare comma list", () => {
  const p = settingsPatch(DEFAULT_SETTINGS, ["reviewer_order=claude,pi"]);
  expect(p.reviewer_order).toEqual(["claude", "pi"]);
});

test("settingsPatch: array field still accepts valid JSON", () => {
  const p = settingsPatch(DEFAULT_SETTINGS, ['reviewer_order=["claude","pi"]']);
  expect(p.reviewer_order).toEqual(["claude", "pi"]);
});

test("settingsPatch: does not mutate DEFAULT_SETTINGS", () => {
  settingsPatch(DEFAULT_SETTINGS, ["harnesses.pi.model=foo", "reviewer_order=claude,pi"]);
  expect(DEFAULT_SETTINGS.harnesses.pi.model).toBe("");
  expect(DEFAULT_SETTINGS.reviewer_order).toEqual(["pi", "opencode", "commandcode", "claude"]);
});

test("settingsPatch: pair without '=' throws naming the bad arg", () => {
  expect(() => settingsPatch(DEFAULT_SETTINGS, ["max_workers"])).toThrow(/max_workers/);
});

test("settingsPatch: empty key throws naming the bad arg", () => {
  expect(() => settingsPatch(DEFAULT_SETTINGS, ["=5"])).toThrow(/=5/);
});

test("settingsPatch: blank key or empty dotted segment throws", () => {
  for (const a of [" =5", "=5", "a..b=1", "a.=1", ".a=1", ".=1"])
    expect(() => settingsPatch(DEFAULT_SETTINGS, [a])).toThrow(/invalid pair \(empty key\)/);
});

test("settingsPatch: empty value throws naming the bad arg", () => {
  expect(() => settingsPatch(DEFAULT_SETTINGS, ["max_workers="])).toThrow(/invalid pair \(empty value\): max_workers=/);
  expect(() => settingsPatch(DEFAULT_SETTINGS, ["max_workers=  "])).toThrow(/invalid pair \(empty value\)/);
});

test("settingsPatch: array setting corrupted into a string heals via the default type", () => {
  const cur = { ...DEFAULT_SETTINGS, reviewer_order: "[claude]" as any };
  expect(settingsPatch(cur, ["reviewer_order=[claude,pi]"]).reviewer_order).toEqual(["claude", "pi"]);
});

test("loadSettings: a global catalog fills in when the repo has none", () => {
  setGlobal(JSON.stringify(CATALOG));
  expect(loadSettings(mkRepo({})).catalog).toEqual(CATALOG); // no catalog key
  expect(loadSettings(mkRepo({ catalog: {} })).catalog).toEqual(CATALOG); // the empty default
});

test("loadSettings: the repo's own catalog wins entirely", () => {
  setGlobal(JSON.stringify(CATALOG));
  const own = { "claude:opus": { cost: 9, quality: 5, family: "claude" } };
  const s = loadSettings(mkRepo({ catalog: own }));
  expect(s.catalog).toEqual(own);
  expect((s as any)[CATALOG_FROM_GLOBAL]).toBeUndefined();
});

test("loadSettings: a missing, empty or unparsable global file means no catalog", () => {
  setGlobal(null);
  expect(loadSettings(mkRepo({})).catalog).toEqual({});
  setGlobal("");
  expect(loadSettings(mkRepo({ catalog: {} })).catalog).toEqual({});
  setGlobal("{ not json");
  expect(loadSettings(mkRepo({ catalog: {} })).catalog).toEqual({});
});

test("loadSettings: a settings save never copies the global catalog into the repo", () => {
  setGlobal(JSON.stringify(CATALOG));
  const repo = mkRepo({});
  saveSettings(repo, { ...loadSettings(repo), max_workers: 5 }); // daemon.ts settings PUT
  expect(savedRepo(repo).catalog).toEqual({});
  expect(savedRepo(repo).max_workers).toBe(5);
  const other = mkRepo({ catalog: {} });
  saveSettings(other, { ...loadSettings(other), base_branch: "dev" }); // supervisor.ts workspace setup
  expect(savedRepo(other).catalog).toEqual({});
});

test("loadSettings: the repo's own catalog survives a settings save", () => {
  setGlobal(JSON.stringify(CATALOG));
  const own = { "pi:hy3": { cost: 2, quality: 5, family: "pi" } };
  const repo = mkRepo({ catalog: own });
  saveSettings(repo, { ...loadSettings(repo), max_workers: 2 });
  expect(savedRepo(repo).catalog).toEqual(own);
});

test("loadSettings: an explicit catalog patch is persisted, not stripped", () => {
  setGlobal(JSON.stringify(CATALOG));
  const repo = mkRepo({});
  const own = { "claude:opus": { cost: 9, quality: 5, family: "claude" } };
  const patch = settingsPatch(loadSettings(repo), [JSON.stringify({ catalog: own })]); // factory settings set '{"catalog":…}'
  saveSettings(repo, { ...loadSettings(repo), ...patch }); // daemon.ts settings PUT
  expect(savedRepo(repo).catalog).toEqual(own);
});

test("loadSettings: a settings save that echoes the inherited catalog back still drops it", () => {
  setGlobal(JSON.stringify(CATALOG));
  const repo = mkRepo({ catalog: {} });
  const echo = JSON.parse(JSON.stringify(loadSettings(repo).catalog)); // the UI PUTs the whole GET body back
  saveSettings(repo, { ...loadSettings(repo), catalog: echo });
  expect(savedRepo(repo).catalog).toEqual({});
});

test("readTicket: a quoted attempts string is read back as a number", () => {
  expect(readTicket(ticketFile(mkRepo(), "T-001", 'attempts: "1"\n')).attempts).toBe(1);
  expect(readTicket(ticketFile(mkRepo(), "T-002", 'attempts: "01"\n')).attempts).toBe(1);
  // supervisor.spawnWorker: (t.attempts ?? 0) + 1 — the "11" bug
  const t = readTicket(ticketFile(mkRepo(), "T-003", 'attempts: "1"\n'));
  expect((t.attempts ?? 0) + 1).toBe(2);
});

test("readTicket: a non-numeric attempts is read back as 0", () => {
  expect(readTicket(ticketFile(mkRepo(), "T-001", 'attempts: "abc"\n')).attempts).toBe(0);
});

test("readTicket: an absent attempts stays undefined", () => {
  expect(readTicket(ticketFile(mkRepo(), "T-001")).attempts).toBeUndefined();
});

test("updateTicket: a string attempts is written unquoted and read back as a number", () => {
  const repo = mkRepo();
  const f = ticketFile(repo, "T-001", "attempts: 0\n");
  expect(updateTicket(repo, "T-001", { attempts: "2" as any }).attempts).toBe(2);
  const text = readFileSync(f, "utf8");
  expect(text).toContain("attempts: 2\n");
  expect(text).not.toContain('"2"');
  expect(readTicket(f).attempts).toBe(2);
});

test("updateTicket: a non-numeric attempts is written as 0", () => {
  const repo = mkRepo();
  const f = ticketFile(repo, "T-001", 'attempts: "abc"\n');
  expect(updateTicket(repo, "T-001", { attempts: "abc" as any }).attempts).toBe(0);
  expect(readFileSync(f, "utf8")).toContain("attempts: 0\n");
});
