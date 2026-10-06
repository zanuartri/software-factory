// Claude Code's session transcript (~/.claude/projects/<encoded cwd>/<session>.jsonl) → the chat thread:
// messages, tool calls with their results, subagents, background tasks (+ their completion notices), todos, AskUserQuestion answers.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type QA = { question: string; header?: string; answer: string | null };
export type AgentInfo = { id: string | null; type: string; desc: string; steps: number; last?: string; done: boolean; report?: string };
export type Todo = { content: string; status: string };
export type ToolInfo = {
  id: string; name: string; detail: string; input: string; status: "running" | "background" | "done" | "error";
  result?: string; task?: string; agent?: AgentInfo; todos?: Todo[]; events?: string[]; // Monitor: lines it reported
};
export type Notice = { kind: "task" | "command" | "message"; status?: string; title: string; body?: string };
export type ChatMsg = { id: string; role: "user" | "assistant" | "tool" | "notice"; text: string; images?: number; qa?: QA[]; skipped?: boolean; tool?: ToolInfo; notice?: Notice };
export type Activity = { running: { name: string; detail: string } | null; background: number };

const PROJECTS = join(homedir(), ".claude", "projects");
type Read = { msgs: ChatMsg[]; model: string | null; activity: Activity; queued: string[] };
const cache = new Map<string, { sig: string } & Read>();

export const transcriptPath = (session: string) => {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) { const f = join(PROJECTS, d, `${session}.jsonl`); if (existsSync(f)) return f; }
  return null;
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? "";
const detailOf = (name: string, i: any) => {
  const v = name === "Agent" || name === "Task" ? i?.description : i?.command ?? i?.file_path ?? i?.pattern ?? i?.path ?? i?.description ?? i?.url ?? i?.query ?? i?.skill ?? i?.name ?? "";
  return String(v ?? "").split("\n")[0].slice(0, 140);
};
const jsonls = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : []);

/** Steps and latest activity of a subagent, from its own sidechain file. */
function agentProgress(dir: string, a: AgentInfo) {
  const f = join(dir, `agent-${a.id}.jsonl`);
  if (!a.id || !existsSync(f)) return;
  let steps = 0, last: string | undefined;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b.type === "tool_use") { steps++; last = `${b.name} ${detailOf(b.name, b.input)}`.trim(); }
      else if (b.type === "text" && b.text?.trim()) last = clip(b.text.trim().replace(/\s+/g, " "), 140);
    }
  }
  a.steps = steps; a.last = last;
}

export function readChat(session: string, limit = 300): Read {
  const f = transcriptPath(session);
  if (!f) return { msgs: [], model: null, activity: { running: null, background: 0 }, queued: [] };
  const subDir = join(dirname(f), session, "subagents");
  const st = statSync(f);
  const sig = [`${st.mtimeMs}:${st.size}`, ...jsonls(subDir).map((s) => { const x = statSync(s); return `${x.mtimeMs}:${x.size}`; })].join("|");
  const hit = cache.get(f);
  if (hit?.sig === sig) return { ...hit, msgs: hit.msgs.slice(-limit) };

  const msgs: ChatMsg[] = [];
  let model: string | null = null;
  const byId = new Map<string, ChatMsg>(); // tool_use id → its message, so results and notifications can find it
  const findTool = (id: string, task?: string) => [...byId.values()].find((m) => m.tool && (m.tool.id === id || (task && m.tool.task === task)))?.tool;

  // Text that reached the model: a user message, or an attachment delivered mid-turn (task notifications, queued messages).
  const note = (raw: string, uuid: string, isMeta?: boolean) => {
    if (!raw) return;
    if (raw.startsWith("<task-notification>")) { // a background command / subagent finished, or a Monitor line
      const status = tag(raw, "status") || "completed", summary = tag(raw, "summary"), event = tag(raw, "event");
      const t = findTool(tag(raw, "tool-use-id"), tag(raw, "task-id"));
      if (event) { // a Monitor line belongs to the still-running watcher, not to a finished task
        if (t) t.events = [...(t.events ?? []), clip(event, 300)].slice(-30);
        else msgs.push({ id: uuid, role: "notice", text: event, notice: { kind: "message", title: `${summary || "Monitor"} · ${clip(event, 160)}` } });
        return;
      }
      if (t) { t.status = status === "completed" ? "done" : "error"; if (t.agent) t.agent.done = status === "completed"; }
      msgs.push({ id: uuid, role: "notice", text: summary, notice: { kind: "task", status, title: summary || `Task ${status}` } });
    } else if (/^<(agent|teammate)-message/.test(raw)) { // a subagent's hand-back report
      const from = raw.match(/from="([^"]+)"/)?.[1] ?? "", body = raw.replace(/^<[^>]+>\s*/, "").replace(/<\/[^>]+>\s*$/, "").replace(/^\[Subagent hand-back\][^\n]*\n?/, "").trim();
      const t = [...byId.values()].find((m) => m.tool?.agent?.id === from)?.tool;
      if (t?.agent) { t.agent.report = body; t.agent.done = true; }
      else msgs.push({ id: uuid, role: "notice", text: from, notice: { kind: "message", title: `Message from ${from || "an agent"}`, body: clip(body, 2000) } });
    } else if (raw.includes("<local-command-stdout>")) { // output of a local slash command (/cost, /context, /model…)
      const out = tag(raw, "local-command-stdout").replace(ANSI, "").trim();
      if (out) msgs.push({ id: uuid, role: "notice", text: out, notice: { kind: "command", title: clip(out.split("\n")[0], 120), body: out.includes("\n") ? clip(out, 3000) : undefined } });
    } else if (raw.includes("<command-name>")) { // built-ins are name-first, skill/plugin commands message-first
      msgs.push({ id: uuid, role: "user", text: `${tag(raw, "command-name")} ${tag(raw, "command-args")}`.trim() });
    } else if (/^\[Request interrupted/.test(raw)) {
      msgs.push({ id: uuid, role: "notice", text: raw, notice: { kind: "command", title: raw.includes("tool use") ? "Interrupted during a tool call" : "Interrupted" } });
    } else if (!raw.startsWith("<") && !isMeta) msgs.push({ id: uuid, role: "user", text: raw }); // "<…>" = injected reminders
  };

  const queue: string[] = []; // messages typed while Claude was busy, until they are delivered
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "queue-operation") {
      const c = String(e.content ?? "");
      if (e.operation === "enqueue") queue.push(c);
      else if (e.operation === "dequeue") queue.shift();
      else if (e.operation === "remove") { const i = queue.indexOf(c); if (i >= 0) queue.splice(i, 1); }
      continue;
    }
    if (e.type === "attachment" && e.attachment?.type === "queued_command") { note(String(e.attachment.prompt ?? "").trim(), e.uuid ?? `q-${msgs.length}`); continue; }
    if (e.type === "system") { // a built-in slash command's own entries: /reload-plugins, /model… carry no message field
      if (e.subtype === "local_command" && typeof e.content === "string") note(e.content, e.uuid ?? `s-${msgs.length}`);
      continue;
    }
    if (e.isSidechain || !e.message) continue;

    if (e.type === "user") {
      const content = e.message.content;
      if (Array.isArray(content)) for (const b of content) if (b.type === "tool_result") {
        const m = byId.get(b.tool_use_id), tur = e.toolUseResult;
        if (!m) continue;
        if (m.qa) { // AskUserQuestion: answers ride on the tool result
          if (tur?.answers) m.qa = m.qa.map((q) => ({ ...q, answer: (tur.answers as Record<string, string>)[q.question] ?? null }));
          else m.skipped = true;
          continue;
        }
        const t = m.tool!, out = clip(String(textOf(b.content) || (typeof b.content === "string" ? b.content : "")).replace(ANSI, "").trim(), 2000);
        t.result = out;
        t.status = b.is_error ? "error" : "done";
        const taskId = tur?.backgroundTaskId ?? (t.name === "Monitor" ? tur?.taskId : undefined);
        if (taskId) { t.task = taskId; t.status = "background"; }
        if (t.agent) {
          if (tur?.agentId) t.agent.id = tur.agentId;
          if (tur?.isAsync && tur.agentId) { t.task = tur.agentId; t.status = "background"; }
          else { t.agent.done = !b.is_error; t.agent.report = out; }
        }
      }
      const raw = textOf(content).trim();
      const images = Array.isArray(content) ? content.filter((b: any) => b.type === "image").length : 0;
      if (raw) note(raw, e.uuid, e.isMeta);
      if (images) { const m = msgs.at(-1); if (raw && m && m.id === e.uuid) m.images = images; else msgs.push({ id: `${e.uuid}:img`, role: "user", text: "", images }); }
    } else if (e.type === "assistant" && Array.isArray(e.message.content)) {
      if (e.message.model && e.message.model !== "<synthetic>") model = e.message.model;
      e.message.content.forEach((b: any, i: number) => {
        const id = `${e.uuid}:${i}`;
        if (b.type === "text" && b.text?.trim()) msgs.push({ id, role: "assistant", text: b.text });
        else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
          const m: ChatMsg = { id, role: "tool", text: "AskUserQuestion", qa: (b.input?.questions ?? []).map((q: any) => ({ question: q.question, header: q.header, answer: null })) };
          msgs.push(m); byId.set(b.id, m);
        } else if (b.type === "tool_use") {
          const tool: ToolInfo = { id: b.id, name: b.name, detail: detailOf(b.name, b.input), input: clip(JSON.stringify(b.input ?? {}, null, 2), 1500), status: "running" };
          if (b.name === "Agent" || b.name === "Task") tool.agent = { id: null, type: b.input?.subagent_type ?? "agent", desc: b.input?.description ?? "", steps: 0, done: false };
          if (b.name === "TodoWrite") tool.todos = (b.input?.todos ?? []).map((t: any) => ({ content: t.content ?? t.activeForm ?? "", status: t.status ?? "pending" }));
          const m: ChatMsg = { id, role: "tool", text: `${b.name} ${tool.detail}`.trim(), tool };
          msgs.push(m); byId.set(b.id, m);
        }
      });
    }
  }
  for (const m of msgs) if (m.tool?.agent) agentProgress(subDir, m.tool.agent);

  let running: Activity["running"] = null, background = 0;
  for (const m of msgs) if (m.tool?.status === "background") background++;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].tool?.status === "running") { running = { name: msgs[i].tool!.name, detail: msgs[i].tool!.detail }; break; }
  const activity = { running, background };
  const queued = queue.filter((q) => q.trim() && !q.startsWith("<"));
  cache.set(f, { sig, msgs, model, activity, queued }); // ponytail: re-parses the whole file on change; tail-read incrementally if transcripts get huge
  return { msgs: msgs.slice(-limit), model, activity, queued };
}
