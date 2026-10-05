// Thin wrapper over the `herdr` CLI: the web chat drives the manager's Claude session that lives in a herdr pane.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HerdrAgent = { pane_id: string; agent: string; agent_status: string; cwd: string; agent_session?: { value?: string } };

async function herdr(...args: string[]) {
  const p = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const j = out.trim() ? (() => { try { return JSON.parse(out); } catch { return null; } })() : null; // `agent read` prints plain text
  if (code !== 0 || j?.error) throw new Error(j?.error?.message ?? (err.trim() || out.trim() || `herdr ${args[0]} failed`));
  return j ? j.result ?? j : out;
}

export const listAgents = async (): Promise<HerdrAgent[]> => (await herdr("agent", "list")).agents ?? [];
export const findAgent = async (session: string) => (await listAgents()).find((a) => a.agent === "claude" && a.agent_session?.value === session) ?? null;

export const prompt = (pane: string, text: string) => herdr("agent", "prompt", pane, text);
export const interrupt = (pane: string) => herdr("agent", "send-keys", pane, "esc");

/** New herdr workspace in `cwd` running claude (optionally `--resume <session>`); resolves to the claude session id once herdr reports it. */
export async function startClaude(cwd: string, label: string, resume?: string) {
  const r = await herdr("workspace", "create", "--cwd", cwd, "--label", label, "--no-focus");
  const pane: string = r.root_pane.pane_id;
  const name = `mgr-${Date.now().toString(36)}`;
  // A folder claude hasn't seen asks "trust this folder?", so `start` can fail as not-ready while the pane lives on; handled in the loop below.
  const startErr = await herdr("agent", "start", name, "--kind", "claude", "--pane", pane, ...(resume ? ["--", "--resume", resume] : [])).then(() => null, (e: Error) => e);
  for (let i = 0; i < 60; i++) { // the session id shows up a moment after the agent is detected
    const a = (await listAgents()).find((x) => x.pane_id === pane);
    if (a?.agent_session?.value) return a.agent_session.value;
    // The folder is a registered factory workspace, so the user already chose to work in it: accept the trust prompt (default is "No, exit").
    if (a?.agent_status === "blocked" && JSON.stringify(await herdr("agent", "read", pane, "--lines", "30")).includes("trust this folder")) await herdr("agent", "send-keys", pane, "down", "enter");
    await Bun.sleep(500);
  }
  throw new Error(startErr?.message ?? "claude started but herdr did not report its session id");
}

// ---- transcript → chat messages (Claude Code writes ~/.claude/projects/<encoded cwd>/<session>.jsonl)
export type ChatMsg = { id: string; role: "user" | "assistant" | "tool"; text: string };
const PROJECTS = join(homedir(), ".claude", "projects");
const cache = new Map<string, { sig: string; msgs: ChatMsg[]; model: string | null }>();

const transcriptPath = (session: string) => {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) { const f = join(PROJECTS, d, `${session}.jsonl`); if (existsSync(f)) return f; }
  return null;
};
const userText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
const toolDetail = (i: any) => String(i?.command ?? i?.file_path ?? i?.pattern ?? i?.path ?? i?.description ?? i?.url ?? "").split("\n")[0].slice(0, 120);

export function readChat(session: string, limit = 300): { msgs: ChatMsg[]; model: string | null } {
  const f = transcriptPath(session);
  if (!f) return { msgs: [], model: null };
  const st = statSync(f), sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(f);
  if (hit?.sig === sig) return { msgs: hit.msgs.slice(-limit), model: hit.model };
  const msgs: ChatMsg[] = [];
  let model: string | null = null;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || e.isMeta || !e.message) continue;
    if (e.type === "user") {
      const t = userText(e.message.content).trim();
      if (t && !t.startsWith("<")) msgs.push({ id: e.uuid, role: "user", text: t }); // "<…>" = injected system-reminder / command wrappers
    } else if (e.type === "assistant" && Array.isArray(e.message.content)) {
      if (e.message.model && e.message.model !== "<synthetic>") model = e.message.model;
      e.message.content.forEach((b: any, i: number) => {
        if (b.type === "text" && b.text?.trim()) msgs.push({ id: `${e.uuid}:${i}`, role: "assistant", text: b.text });
        else if (b.type === "tool_use") msgs.push({ id: `${e.uuid}:${i}`, role: "tool", text: `${b.name} ${toolDetail(b.input)}`.trim() });
      });
    }
  }
  cache.set(f, { sig, msgs, model }); // ponytail: re-parses the whole file on change; tail-read incrementally if transcripts get huge
  return { msgs: msgs.slice(-limit), model };
}

// ---- slash commands for the chat autocomplete: built-ins + user/project/plugin commands and skills
export type SlashCmd = { name: string; desc: string };
const BUILTIN: SlashCmd[] = [
  ["clear", "Start a fresh conversation"], ["compact", "Summarize the conversation to free context"], ["model", "Switch model"], ["effort", "Set reasoning effort"],
  ["context", "Show context usage"], ["cost", "Show session cost"], ["resume", "Resume a past session"], ["init", "Create a CLAUDE.md"], ["memory", "Edit memory files"],
  ["permissions", "Manage tool permissions"], ["mcp", "Manage MCP servers"], ["agents", "Manage subagents"], ["plugin", "Manage plugins"], ["config", "Open settings"],
  ["status", "Show session status"], ["help", "Show help"], ["rewind", "Rewind the conversation"], ["export", "Export the conversation"], ["review", "Review a pull request"],
].map(([name, desc]) => ({ name, desc }));

const frontDesc = (f: string) => readFileSync(f, "utf8").match(/^description:\s*(.+)$/m)?.[1].replace(/^["']|["']$/g, "").slice(0, 140) ?? "";
function scan(root: string, prefix: string, out: SlashCmd[]) {
  const cmds = join(root, "commands"), skills = join(root, "skills");
  const walk = (dir: string, ns: string) => { // commands/a/b.md → a:b
    for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(join(dir, e.name), `${ns}${e.name}:`);
      else if (e.name.endsWith(".md")) out.push({ name: `${prefix}${ns}${e.name.slice(0, -3)}`, desc: frontDesc(join(dir, e.name)) });
    }
  };
  walk(cmds, "");
  for (const e of existsSync(skills) ? readdirSync(skills, { withFileTypes: true }) : []) {
    const f = join(skills, e.name, "SKILL.md");
    if (existsSync(f)) out.push({ name: `${prefix}${e.name}`, desc: frontDesc(f) });
  }
}
const cmdCache = new Map<string, { at: number; cmds: SlashCmd[] }>();
export function slashCommands(cwd: string): SlashCmd[] {
  const hit = cmdCache.get(cwd);
  if (hit && Date.now() - hit.at < 30e3) return hit.cmds;
  const out: SlashCmd[] = [];
  const home = join(homedir(), ".claude");
  scan(home, "", out);
  scan(join(cwd, ".claude"), "", out);
  try {
    const plugins = JSON.parse(readFileSync(join(home, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
    for (const [key, installs] of Object.entries<any[]>(plugins)) for (const i of installs) if (i.installPath && existsSync(i.installPath)) scan(i.installPath, `${key.split("@")[0]}:`, out);
  } catch {}
  const seen = new Set<string>();
  const cmds = [...BUILTIN, ...out].filter((c) => !seen.has(c.name) && seen.add(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  cmdCache.set(cwd, { at: Date.now(), cmds });
  return cmds;
}


// ---- usage: Claude Code only hands context + rate limits to its statusline, so read them off the pane's rendered statusline
export type Meter = { pct: number; reset?: string };
export type Usage = { ctx: (Meter & { used: string; size: string }) | null; h5: Meter | null; d7: Meter | null };
export async function readUsage(pane: string): Promise<Usage> {
  const t = String(await herdr("agent", "read", pane, "--source", "visible", "--lines", "20").catch(() => ""));
  const meter = (label: string): Meter | null => { const m = t.match(new RegExp(`${label}\\s+(\\d+)%(?:\\s*↻(\\S+))?`)); return m ? { pct: +m[1], reset: m[2] } : null; };
  const c = t.match(/ctx\s+\S+\s+(\d+)%\s+(\S+)\/(\S+)/);
  return { ctx: c ? { pct: +c[1], used: c[2], size: c[3] } : null, h5: meter("5h"), d7: meter("7d") };
}
