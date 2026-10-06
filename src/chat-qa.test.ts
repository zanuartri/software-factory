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

test("agentName: a valid, stable herdr agent name for any workspace id", async () => {
  const { agentName } = await import("./herdr");
  expect(agentName("software-factory")).toBe("factory-software-factory");
  expect(agentName("My Repo.v2")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(agentName("x".repeat(80)).length).toBe(32);
});

const use = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: `a-${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, tur?: unknown, extra: object = {}) => ({ type: "user", uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] }, toolUseResult: tur });
const note = (uuid: string, xml: string) => ({ type: "user", uuid, message: { role: "user", content: xml } });
const write = (name: string, rows: object[]) => writeFileSync(join(home, ".claude", "projects", "p", `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n"));

test("tool calls carry their result and error state; a running call is the activity", () => {
  write("s2", [use("t1", "Bash", { command: "ls" }), result("t1", "a.txt\n", { stdout: "a.txt" }), use("t2", "Read", { file_path: "x" }), result("t2", "boom", undefined, { is_error: true }), use("t3", "Grep", { pattern: "foo" })]);
  const r = readChat("s2");
  expect(r.msgs.map((m) => [m.tool!.name, m.tool!.status, m.tool!.result])).toEqual([["Bash", "done", "a.txt"], ["Read", "error", "boom"], ["Grep", "running", undefined]]);
  expect(r.activity).toEqual({ running: { name: "Grep", detail: "foo" }, background: 0 });
});

test("a background command stays 'background' until its task-notification arrives", () => {
  write("s3", [use("b1", "Bash", { command: "sleep 9", run_in_background: true }), result("b1", "started", { backgroundTaskId: "bx1" })]);
  expect(readChat("s3").activity.background).toBe(1);
  write("s3", [use("b1", "Bash", { command: "sleep 9", run_in_background: true }), result("b1", "started", { backgroundTaskId: "bx1" }),
    note("n1", "<task-notification>\n<task-id>bx1</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command done</summary>\n</task-notification>")]);
  const r = readChat("s3");
  expect(r.activity.background).toBe(0);
  expect(r.msgs[0].tool!.status).toBe("done");
  expect(r.msgs[1].notice).toMatchObject({ kind: "task", status: "completed", title: "Background command done" });
});

test("an async subagent: launched in the background, then its hand-back report lands on the card", () => {
  write("s4", [use("g1", "Agent", { description: "count files", subagent_type: "general-purpose", run_in_background: true }),
    result("g1", "Async agent launched", { isAsync: true, agentId: "ag1" }),
    note("m1", '<agent-message from="ag1">\n[Subagent hand-back] this is its final report\nThere are 4 files.\n</agent-message>')]);
  const t = readChat("s4").msgs[0].tool!;
  expect(t.agent).toMatchObject({ id: "ag1", desc: "count files", type: "general-purpose", done: true });
  expect(t.agent!.report).toBe("There are 4 files.");
});

test("Monitor: each event lands on the watcher, which keeps running", () => {
  write("s5", [use("m1", "Monitor", { command: "x" }), result("m1", "Monitor started", { taskId: "mon1" }),
    note("e1", "<task-notification>\n<task-id>mon1</task-id>\n<summary>Monitor event</summary>\n<event>tick 1</event>\n</task-notification>"),
    note("e2", "<task-notification>\n<task-id>mon1</task-id>\n<summary>Monitor event</summary>\n<event>tick 2</event>\n</task-notification>")]);
  const r = readChat("s5");
  expect(r.msgs).toHaveLength(1);
  expect(r.msgs[0].tool).toMatchObject({ status: "background", events: ["tick 1", "tick 2"] });
  expect(r.activity.background).toBe(1);
});

test("TodoWrite becomes a checklist; local command output becomes a notice", () => {
  write("s6", [use("d1", "TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }),
    note("c1", "<local-command-stdout>Total cost: $0.10\nDuration: 3s</local-command-stdout>")]);
  const r = readChat("s6");
  expect(r.msgs[0].tool!.todos).toEqual([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }]);
  expect(r.msgs[1].notice).toMatchObject({ kind: "command", title: "Total cost: $0.10" });
});

const queued = (uuid: string, prompt: string) => ({ type: "attachment", uuid, attachment: { type: "queued_command", prompt } });
const qop = (operation: string, content?: string) => ({ type: "queue-operation", operation, content });

test("a task-notification delivered mid-turn (as a queued_command attachment) still finishes the background task", () => {
  write("s7", [use("b1", "Bash", { command: "bun run daemon", run_in_background: true }), result("b1", "started", { backgroundTaskId: "bx9" }),
    qop("enqueue", "<task-notification>x</task-notification>"),
    qop("remove", "<task-notification>x</task-notification>"),
    queued("n9", "<task-notification>\n<task-id>bx9</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>failed</status>\n<summary>Background command failed with exit code 1</summary>\n</task-notification>")]);
  const r = readChat("s7");
  expect(r.activity.background).toBe(0);
  expect(r.msgs[0].tool!.status).toBe("error");
  expect(r.msgs[1].notice).toMatchObject({ kind: "task", status: "failed" });
});

test("messages typed while Claude is busy stay queued until delivered; delivered ones become user messages", () => {
  write("s8", [qop("enqueue", "first"), qop("enqueue", "second"), qop("enqueue", "<task-notification>n</task-notification>")]);
  expect(readChat("s8").queued).toEqual(["first", "second"]); // notifications are not user messages
  write("s8", [qop("enqueue", "first"), qop("enqueue", "second"), qop("remove", "first"), queued("q1", "first"), qop("dequeue")]);
  const r = readChat("s8");
  expect(r.queued).toEqual([]);
  expect(r.msgs.map((m) => [m.role, m.text])).toEqual([["user", "first"]]);
});

test("a skill/plugin slash command shows as a user bubble; its skill expansion stays hidden", () => {
  write("s10", [
    note("k1", "<command-message>factory:run</command-message>\n<command-name>/factory:run</command-name>"),
    note("k2", "<command-message>factory:plan</command-message>\n<command-name>/factory:plan</command-name>\n<command-args>x y</command-args>"),
    note("k3", "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"),
    { type: "user", uuid: "k4", isMeta: true, message: { role: "user", content: "Base directory for this skill: /tmp/plan\n\nARGUMENTS: x y" } },
  ]);
  expect(readChat("s10").msgs.map((m) => [m.role, m.text])).toEqual([["user", "/factory:run"], ["user", "/factory:plan x y"], ["user", "/clear"]]);
});

test("a pasted image is counted on the user message", () => {
  write("s9", [{ type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", data: "AAAA" } }] } }]);
  expect(readChat("s9").msgs[0]).toMatchObject({ role: "user", text: "what is this", images: 1 });
});
