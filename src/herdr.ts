// Thin wrapper over the `herdr` CLI: the web chat drives the manager's Claude session that lives in a herdr pane.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HerdrAgent = { pane_id: string; name?: string; agent: string; agent_status: string; cwd: string; agent_session?: { value?: string } };

async function herdr(...args: string[]) {
  const p = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const j = out.trim() ? (() => { try { return JSON.parse(out); } catch { return null; } })() : null; // `agent read` prints plain text
  if (code !== 0 || j?.error) throw new Error(j?.error?.message ?? (err.trim() || out.trim() || `herdr ${args[0]} failed`));
  return j ? j.result ?? j : out;
}

export const listAgents = async (): Promise<HerdrAgent[]> => (await herdr("agent", "list")).agents ?? [];
/** The manager's herdr name: it follows the pane, so it survives /clear (new session id) and daemon restarts. */
export const agentName = (wsId: string) => `factory-${wsId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);
export const findByName = async (name: string) => (await listAgents()).find((a) => a.agent === "claude" && a.name === name) ?? null;
export const nameAgent = (pane: string, name: string) => herdr("agent", "rename", pane, name);
export const findAgent = async (session: string) => (await listAgents()).find((a) => a.agent === "claude" && a.agent_session?.value === session) ?? null;

export const prompt = (pane: string, text: string) => herdr("agent", "prompt", pane, text);
export const interrupt = (pane: string) => herdr("agent", "send-keys", pane, "esc");

/** New herdr workspace in `cwd` running claude (optionally `--resume <session>`); resolves to the claude session id once herdr reports it. */
export async function startClaude(cwd: string, label: string, name: string, resume?: string) {
  const r = await herdr("workspace", "create", "--cwd", cwd, "--label", label, "--no-focus");
  const pane: string = r.root_pane.pane_id;
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

// ---- transcript → chat thread lives in ./transcript
export { readChat, type ChatMsg } from "./transcript";

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
/** One read of the pane's visible text serves usage and prompt detection. */
export const readScreen = async (pane: string) => String(await herdr("agent", "read", pane, "--source", "visible", "--lines", "60").catch(() => ""));
export function usageFrom(t: string): Usage {
  const meter = (label: string): Meter | null => { const m = t.match(new RegExp(`${label}\\s+(\\d+)%(?:\\s*↻(\\S+))?`)); return m ? { pct: +m[1], reset: m[2] } : null; };
  const c = t.match(/ctx\s+\S+\s+(\d+)%\s+(\S+)\/(\S+)/);
  return { ctx: c ? { pct: +c[1], used: c[2], size: c[3] } : null, h5: meter("5h"), d7: meter("7d") };
}

// ---- interactive prompts (AskUserQuestion, permission, plan approval…): read the screen, answer with key presses
import { parsePrompt, type Prompt } from "./prompt";
export type { Prompt };

/** The question on screen, if any. herdr's own status isn't reliable for this (it can say "done" with a question up), so the screen decides;
 *  `blocked` only buys a raw fallback for a dialog the parser doesn't know. */
export async function promptFrom(pane: string, plain: string, blocked: boolean): Promise<Prompt | { raw: string } | null> {
  const p = parsePrompt(plain);
  if (!p) return blocked && plain.trim() ? { raw: plain } : null;
  if (!p.tabs.length) return p;
  const ansi = String(await herdr("agent", "read", pane, "--source", "visible", "--lines", "60", "--format", "ansi").catch(() => "")); // the active tab is only visible in colour
  return parsePrompt(plain, ansi) ?? p;
}

const KEY = /^(esc|enter|tab|shift\+tab|up|down|left|right|space|backspace|ctrl\+g|[0-9a-z])$/i;
export type Answer = { keys?: string[]; text?: string; enter?: boolean };
/** Keys first (a number picks an option, ←/→ switch tabs, Tab amends), then literal text, then Enter — the same sequence a person types. */
export async function answer(pane: string, a: Answer) {
  const keys = (a.keys ?? []).filter((k) => KEY.test(k));
  if (keys.length) await herdr("agent", "send-keys", pane, ...keys);
  if (a.text) { if (keys.length) await Bun.sleep(250); await herdr("pane", "send-text", pane, a.text); }
  if (a.enter) { if (a.text) await Bun.sleep(150); await herdr("agent", "send-keys", pane, "enter"); }
}

/** Close one pane (the agent in it exits). Used to retire the previous manager session before a new one takes its name. */
export const closePane = (pane: string) => herdr("pane", "close", pane);
