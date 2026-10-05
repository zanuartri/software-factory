import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "factory-qa-"));
process.env.HOME = home; process.env.USERPROFILE = home; // readChat looks under ~/.claude/projects
mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
const { readChat } = await import("./herdr");

const line = (o: unknown) => JSON.stringify(o);
test("AskUserQuestion: the answers are attached to the question once they arrive, and a rejection is marked skipped", () => {
  const ask = (id: string) => ({ type: "assistant", uuid: `a-${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: "Pick?", header: "H", options: [] }] } }] } });
  writeFileSync(join(home, ".claude", "projects", "p", "s1.jsonl"), [
    ask("t1"),
    line({ type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }, toolUseResult: { answers: { "Pick?": "Green" } } }),
    ask("t2"),
    line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "no" }] } }),
    ask("t3"),
  ].map((l) => (typeof l === "string" ? l : line(l))).join("\n"));
  const qa = readChat("s1").msgs.filter((m) => m.qa);
  expect(qa[0].qa).toEqual([{ question: "Pick?", header: "H", answer: "Green" }]);
  expect(qa[1].skipped).toBe(true);
  expect(qa[2].qa![0].answer).toBeNull(); // still pending
});
