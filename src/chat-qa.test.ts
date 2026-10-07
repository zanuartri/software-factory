import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("readChat carries transcript timestamps on user, assistant, and notice rows", () => {
  write("s-timestamps", [
    { type: "user", uuid: "u-ts", timestamp: "2026-02-01T10:00:00.000Z", message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "a-ts", timestamp: "2026-02-01T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
    { type: "user", uuid: "n-ts", timestamp: "2026-02-01T10:02:00.000Z", message: { role: "user", content: "<bash-stdout>ok</bash-stdout>" } },
    { type: "assistant", uuid: "a-no-ts", message: { role: "assistant", content: [{ type: "text", text: "untimed reply" }] } },
    { type: "user", uuid: "u-no-ts", message: { role: "user", content: "untimed" } },
  ]);
  expect(readChat("s-timestamps").msgs.map(({ id, ts }) => [id, ts])).toEqual([
    ["u-ts", Date.parse("2026-02-01T10:00:00.000Z")],
    ["a-ts:0", Date.parse("2026-02-01T10:01:00.000Z")],
    ["n-ts", Date.parse("2026-02-01T10:02:00.000Z")],
    ["a-no-ts:0", undefined],
    ["u-no-ts", undefined],
  ]);
});
test("readChat reports the full row count and returns the requested tail", () => {
  write("s-limit", [note("u1", "first"), note("u2", "second"), note("u3", "third")]);
  expect(readChat("s-limit", 2)).toMatchObject({ total: 3, msgs: [{ id: "u2", text: "second" }, { id: "u3", text: "third" }] });
  expect(readChat("s-limit", 1)).toMatchObject({ total: 3, msgs: [{ id: "u3", text: "third" }] });
});
test("readChat revision is shared while total and message tails reflect each limit", () => {
  write("s-limit", [note("u1", "first"), note("u2", "second"), note("u3", "third")]);
  const small = readChat("s-limit", 1), large = readChat("s-limit", 2);
  expect(small.total).toBe(3);
  expect(large.total).toBe(3);
  expect(small.msgs.map((m) => m.text)).toEqual(["third"]);
  expect(large.msgs.map((m) => m.text)).toEqual(["second", "third"]);
});


test("readChat revision covers stable transcript reads, appended entries, and sidechain changes", () => {
  write("s-revision", [note("u1", "first")]);
  const transcript = join(home, ".claude", "projects", "p", "s-revision.jsonl");
  const first = readChat("s-revision").rev;
  expect(readChat("s-revision").rev).toBe(first);
  appendFileSync(transcript, `\n${line(note("u2", "second"))}`);
  const appended = readChat("s-revision").rev;
  expect(appended).not.toBe(first);
  const sidecars = join(home, ".claude", "projects", "p", "s-revision", "subagents");
  mkdirSync(sidecars, { recursive: true });
  const sidecar = join(sidecars, "agent-ag1.jsonl");
  writeFileSync(sidecar, `${line({ type: "assistant", message: { content: [{ type: "text", text: "one" }] } })}\n`);
  const withSidecar = readChat("s-revision").rev;
  appendFileSync(sidecar, `${line({ type: "assistant", message: { content: [{ type: "text", text: "two" }] } })}\n`);
  expect(readChat("s-revision").rev).not.toBe(withSidecar);
});

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

test("a top-level system/local_command entry shows its stdout as a notice; other system subtypes stay hidden", () => {
  write("s11", [
    { type: "system", subtype: "local_command", uuid: "sys1", content: "<local-command-stdout>Reloaded: 4 plugins\nReloaded: x, y, z, w</local-command-stdout>" },
    { type: "system", subtype: "turn_duration", uuid: "sys2", durationMs: 1200 },
  ]);
  expect(readChat("s11").msgs.map((m) => [m.role, m.text, m.notice?.kind, m.notice?.title])).toEqual([
    ["notice", "Reloaded: 4 plugins\nReloaded: x, y, z, w", "command", "Reloaded: 4 plugins"],
  ]);
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

test("a user message that merely mentions <command-name> mid-string stays a user bubble", () => {
  write("s11", [note("k5", "how do I use <command-name> in a transcript?")]);
  expect(readChat("s11").msgs.map((m) => [m.role, m.text])).toEqual([["user", "how do I use <command-name> in a transcript?"]]);
});

test("a pasted image is counted on the user message", () => {
  write("s9", [{ type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", data: "AAAA" } }] } }]);
  expect(readChat("s9").msgs[0]).toMatchObject({ role: "user", text: "what is this", images: 1 });
});

test("user text that merely starts with '<' is still a user message", () => {
  write("s12", [note("u1", "<div>hi</div>"), note("u2", "<3 you")]);
  expect(readChat("s12").msgs.map((m) => [m.role, m.text])).toEqual([["user", "<div>hi</div>"], ["user", "<3 you"]]);
});

test("a leading <system-reminder> block is dropped, but the real text beside it survives; a reminder-only entry stays hidden", () => {
  write("s13", [
    { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "<system-reminder>\nbe nice\n</system-reminder>" }, { type: "text", text: "real text" }] } },
    { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "<system-reminder>\nonly a reminder\n</system-reminder>" }] } },
    { type: "user", uuid: "u3", message: { role: "user", content: "<system-reminder>string reminder</system-reminder>" } },
  ]);
  expect(readChat("s13").msgs.map((m) => [m.role, m.text])).toEqual([["user", "real text"]]);
});

test("a /compact summary entry produces no row", () => {
  write("s14", [
    { type: "user", uuid: "c1", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: stuff" } },
    note("u1", "hello"),
  ]);
  expect(readChat("s14").msgs.map((m) => [m.role, m.text])).toEqual([["user", "hello"]]);
});

test("entries repeated after a resume/compaction (same uuid) yield one row each", () => {
  write("s15", [note("u1", "hello"), note("u1", "hello"), use("t1", "Bash", { command: "ls" }), use("t1", "Bash", { command: "ls" })]);
  expect(readChat("s15").msgs.map((m) => [m.role, m.text])).toEqual([["user", "hello"], ["tool", "Bash ls"]]);
});

test("a !-bash user command shows as a user bubble; its ANSI-stripped output becomes a command notice", () => {
  write("s16", [
    note("b1", "<bash-input>ls</bash-input>"),
    note("b2", "<bash-stdout>\x1b[32ma.txt\x1b[0m\nb.txt</bash-stdout><bash-stderr>permission denied</bash-stderr>"),
  ]);
  expect(readChat("s16").msgs.map((m) => [m.role, m.text, m.notice?.kind])).toEqual([
    ["user", "!ls", undefined],
    ["notice", "a.txt\nb.txt\npermission denied", "command"],
  ]);
});

test("a kept block with leading whitespace still routes as its own row, not raw XML", () => {
  write("s20", [{ type: "user", uuid: "w1", message: { role: "user", content: [{ type: "text", text: " \n<bash-input>ls</bash-input>" }] } }]);
  expect(readChat("s20").msgs.map((m) => [m.role, m.text])).toEqual([["user", "!ls"]]);
});

test("an entry with two kept text blocks yields distinct row ids; the first row keeps the entry uuid", () => {
  write("s21", [{ type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] } }]);
  const m = readChat("s21").msgs;
  expect(m.map((x) => x.text)).toEqual(["one", "two"]);
  expect(m[0].id).toBe("u1");
  expect(m[1].id).not.toBe(m[0].id);
});

test("a <pasted_content> user entry unwraps to the inner text", () => {
  write("s17", [note("p1", '<pasted_content lines="2">hello\nworld</pasted_content>')]);
  expect(readChat("s17").msgs.map((m) => [m.role, m.text])).toEqual([["user", "hello\nworld"]]);
});

test("an array-content text block that is a task-notification renders the task notice instead of being dropped", () => {
  write("s18", [
    use("b1", "Bash", { command: "sleep 9", run_in_background: true }), result("b1", "started", { backgroundTaskId: "bx1" }),
    { type: "user", uuid: "n1", message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<task-id>bx1</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command done</summary>\n</task-notification>" }] } },
  ]);
  const r = readChat("s18");
  expect(r.msgs[0].tool!.status).toBe("done");
  expect(r.msgs[1].notice).toMatchObject({ kind: "task", status: "completed", title: "Background command done" });
});

test("a system/local_command entry with plain text or isSidechain yields no row, but its stdout still shows", () => {
  write("s19", [
    { type: "system", subtype: "local_command", uuid: "x1", content: "just some plain prose" },
    { type: "system", subtype: "local_command", uuid: "x2", isSidechain: true, content: "<local-command-stdout>sidechain output</local-command-stdout>" },
    { type: "system", subtype: "local_command", uuid: "x3", content: "<local-command-stdout>kept output</local-command-stdout>" },
  ]);
  expect(readChat("s19").msgs.map((m) => [m.role, m.text, m.notice?.kind])).toEqual([["notice", "kept output", "command"]]);
});
