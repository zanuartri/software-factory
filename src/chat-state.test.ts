import { expect, test } from "bun:test";
import { reconcilePending } from "../ui/src/chat-state";

type Pending = { key: string; text: string; after: string | null; imgs: string[]; claimed?: string[] };
const pending = (...texts: string[]): Pending[] => texts.map((text, i) => ({ key: `p${i}`, text, after: "anchor", imgs: [] }));
const msg = (id: string, text: string, role = "user") => ({ id, text, role });

test("matches duplicate queued sends by occurrence, not includes", () => {
  expect(reconcilePending(pending("same", "same"), [], ["same"]).map((p) => p.key)).toEqual(["p1"]);
  expect(reconcilePending(pending("same", "same"), [msg("m1", "same")], ["same"])).toEqual([]);
});

test("a queued occurrence stays claimed when it later becomes confirmed", () => {
  const first = reconcilePending(pending("same", "same"), [], ["same"]);
  expect(first.map((p) => p.key)).toEqual(["p1"]);
  const confirmedFirst = reconcilePending(first, [msg("anchor", "old"), msg("m1", "same")], []);
  expect(confirmedFirst.map((p) => p.key)).toEqual(["p1"]);
  expect(reconcilePending(confirmedFirst, [msg("anchor", "old"), msg("m1", "same"), msg("m2", "same")], []).map((p) => p.key)).toEqual([]);
});

test("claims confirmed occurrences after an earlier unmatched entry", () => {
  const ps = pending("rewritten", "same", "same"), messages = [msg("anchor", "old"), msg("m1", "same")];
  const first = reconcilePending(ps, messages, []);
  expect(first.map((p) => p.key)).toEqual(["p0", "p2"]);
  expect(reconcilePending(first, messages, []).map((p) => p.key)).toEqual(["p0", "p2"]);
});

test("preserves queued reservations after an earlier unmatched entry", () => {
  const ps = pending("rewritten", "same", "same"), first = reconcilePending(ps, [], ["same"]);
  expect(first.map((p) => p.key)).toEqual(["p0", "p2"]);
  const confirmed = [msg("anchor", "old"), msg("m1", "same")];
  const second = reconcilePending(first, confirmed, []);
  expect(second.map((p) => p.key)).toEqual(["p0", "p2"]);
  expect(reconcilePending(second, confirmed, []).map((p) => p.key)).toEqual(["p0", "p2"]);
});

test("a confirmed message claimed by a removed send stays claimed", () => {
  const first = reconcilePending(pending("same", "same"), [msg("anchor", "old"), msg("m1", "same")], []);
  expect(first.map((p) => p.key)).toEqual(["p1"]);
  expect(reconcilePending(first, [msg("anchor", "old"), msg("m1", "same")], []).map((p) => p.key)).toEqual(["p1"]);
});

test("falls back to visible user messages after anchor leaves the window", () => {
  expect(reconcilePending(pending("delivered"), [msg("m1", "delivered"), msg("a", "delivered", "assistant")], []).map((p) => p.key)).toEqual([]);
});

test("trims exact text but keeps slash commands and mention lines verbatim", () => {
  expect(reconcilePending(pending(" /deploy ", "@\"a file.ts\""), [msg("m1", "/deploy"), msg("m2", "@\"a file.ts\"")], []).map((p) => p.key)).toEqual([]);
  expect(reconcilePending(pending("/deploy", "/deploy"), [msg("m1", "/deploy extra")], []).map((p) => p.key)).toEqual(["p0", "p1"]);
});

test("leaves entries untouched unless queue or confirmed user message matches", () => {
  expect(reconcilePending(pending("failed"), [], [])).toEqual(pending("failed"));
});
