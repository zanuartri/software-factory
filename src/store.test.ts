import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS, settingsPatch } from "./store";

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
