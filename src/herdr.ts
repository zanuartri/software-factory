// Thin wrapper over the `herdr` CLI: the web chat drives the manager's Claude session that lives in a herdr pane.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** Clear the input box first (ctrl+u), or a draft/queued message restored by esc esc merges into `text`. Skip the clear while a modal is up: `clear=false` when the agent is blocked. */
export const prompt = async (pane: string, text: string, clear = true) => {
  if (clear) await herdr("agent", "send-keys", pane, "ctrl+u");
  return herdr("agent", "prompt", pane, text);
};
export const interrupt = (pane: string) => herdr("agent", "send-keys", pane, "esc");

/** New herdr workspace in `cwd` running claude (optionally `--resume <session>`); resolves to the claude session id once herdr reports it. */
/** Standing instruction for a manager session started from the web: who it is and which skill to load. Appended to Claude Code's system prompt. */
export const managerBrief = (ws: { name: string; path: string }) =>
  `You are the factory manager for the workspace "${ws.name}" (${ws.path}). The human chats with you in the factory web console. Load the \`manager\` skill (factory:manager) before acting on tickets, issues, workers or the board, and \`ticketing\` (factory:ticketing) before writing or rewriting a brief. Orient with \`factory status\`; if .factory/rules.md was never scanned, run /factory:init. You never edit the repo's source yourself: every code change is a ticket a worker executes.`;

export async function startClaude(cwd: string, label: string, name: string, resume?: string, append?: string) {
  const r = await herdr("workspace", "create", "--cwd", cwd, "--label", label, "--no-focus");
  const pane: string = r.root_pane.pane_id;
  // A folder claude hasn't seen asks "trust this folder?", so `start` can fail as not-ready while the pane lives on; handled in the loop below.
  const startErr = await herdr("agent", "start", name, "--kind", "claude", "--pane", pane, ...(resume || append ? ["--", ...(resume ? ["--resume", resume] : []), ...(append ? ["--append-system-prompt", append] : [])] : [])).then(() => null, (e: Error) => e);
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
  ["goal", "Keep working until a condition is met"], ["loop", "Run a prompt repeatedly on an interval"], ["plan", "Enter plan mode"], ["fast", "Toggle fast mode"],
  ["usage", "Show cost, plan limits and activity"],
  ["remote-control", "Control this session from another device"], ["reload-plugins", "Reload plugins to apply pending changes"], ["reload-skills", "Re-scan skills and commands"],
  ["add-dir", "Add a working directory for file access"], ["cd", "Move the session to another directory"], ["diff", "Show the changes in the working tree"],
  ["code-review", "Review the current diff for bugs"], ["security-review", "Review the diff for security issues"], ["doctor", "Run a setup checkup"], ["skills", "List available skills"],
  ["hooks", "View hook configurations"], ["tasks", "View and manage background work"], ["rename", "Rename the current session"], ["output-style", "Switch output style"],
  ["statusline", "Configure the status line"], ["theme", "Change the color theme"], ["sandbox", "Toggle sandbox mode"], ["ide", "Manage IDE integrations"],
  ["login", "Sign in to your Anthropic account"], ["logout", "Sign out of your Anthropic account"], ["exit", "Exit the CLI"],
  ["branch", "Branch the conversation to try another direction"], ["fork", "Copy the conversation into a background session"], ["btw", "Ask a side question without adding to the conversation"],
  ["bug", "Report a bug with session context"], ["workflows", "Watch running workflows"], ["feedback", "Send feedback about Claude Code"],
].map(([name, desc]) => ({ name, desc }));

const frontDesc = (f: string) => readFileSync(f, "utf8").match(/^description:\s*(.+)$/m)?.[1].replace(/^["']|["']$/g, "").slice(0, 140) ?? "";
function scan(root: string, prefix: string, out: SlashCmd[]) {
  const cmds = join(root, "commands");
  const walk = (dir: string, ns: string) => { // commands/a/b.md → a:b
    for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(join(dir, e.name), `${ns}${e.name}:`);
      else if (e.name.endsWith(".md")) out.push({ name: `${prefix}${ns}${e.name.slice(0, -3)}`, desc: frontDesc(join(dir, e.name)) });
    }
  };
  walk(cmds, "");
  scanSkills(join(root, "skills"), prefix, out);
}
/** A skills dir: children `<name>/SKILL.md` with a frontmatter description. */
function scanSkills(skills: string, prefix: string, out: SlashCmd[]) {
  for (const e of existsSync(skills) ? readdirSync(skills, { withFileTypes: true }) : []) {
    const f = join(skills, e.name, "SKILL.md");
    if (existsSync(f)) out.push({ name: `${prefix}${e.name}`, desc: frontDesc(f) });
  }
}
/** Newest tmpdir/claude/bundled-skills/<randomBytes-hex> dir — where Claude Code extracts its bundled skills — or null when it never ran here. */
export function bundledSkillsRoot(base = join(tmpdir(), "claude", "bundled-skills")): string | null {
  const dirs = (existsSync(base) ? readdirSync(base, { withFileTypes: true }) : [])
    .filter((e) => e.isDirectory() && /^[0-9a-f]+$/.test(e.name))
    .map((e) => join(base, e.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}
const cmdCache = new Map<string, { at: number; cmds: SlashCmd[] }>();
/** Drop every per-cwd list so the next slashCommands() rescans the plugin/command dirs. */
export function clearCommandCache() {
  cmdCache.clear();
}
/** Called with the raw text sent to a pane: `/reload-plugins` (any args) reloads the plugins, so the menu must not serve the 30s-old list. */
export function noteSent(text: string) {
  if (String(text ?? "").trim().split(/\s+/)[0] === "/reload-plugins") clearCommandCache();
}
/** Swappable so a test can count evaluations; the discovery runs only on a cache miss. */
export const discoverBundled = { get: bundledSkillsRoot };
export function slashCommands(cwd: string, bundled?: string | null): SlashCmd[] {
  const hit = cmdCache.get(cwd);
  if (hit && Date.now() - hit.at < 30e3) return hit.cmds;
  const root = bundled === undefined ? discoverBundled.get() : bundled;
  const out: SlashCmd[] = [];
  const home = join(homedir(), ".claude");
  scan(home, "", out);
  scan(join(cwd, ".claude"), "", out);
  try {
    const plugins = JSON.parse(readFileSync(join(home, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
    for (const [key, installs] of Object.entries<any[]>(plugins)) for (const i of installs) if (i.installPath && existsSync(i.installPath)) scan(i.installPath, `${key.split("@")[0]}:`, out);
  } catch {}
  if (root) scanSkills(root, "", out); // bundled skills register without a prefix
  const seen = new Set<string>();
  const cmds = [...BUILTIN, ...out].filter((c) => !seen.has(c.name) && seen.add(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  cmdCache.set(cwd, { at: Date.now(), cmds });
  return cmds;
}


// ---- usage: Claude Code only hands context + rate limits to its statusline, so read them off the pane's rendered statusline
export type Meter = { pct: number; reset?: string };
export type Usage = { ctx: (Meter & { used: string; size: string }) | null; h5: Meter | null; d7: Meter | null };
/** ANSI pane text supports suggestion detection and color-aware prompt parsing. */
export const readAnsiScreen = async (pane: string) => String(await herdr("agent", "read", pane, "--source", "visible", "--lines", "60", "--format", "ansi").catch(() => ""));
/** Claude renders prompt suggestions as dim text after the input marker; ordinary drafts are not dim. */
export function suggestionFrom(screen: string): string | null {
  if (/Accessing workspace:|Quick safety check:|Enter to confirm|Esc to cancel|trust this folder|✻\s*(?:Thinking|Working|Running)|Thinking…|esc to interrupt|ctrl\+c to interrupt/i.test(screen)) return null;
  for (const line of screen.replace(/\r/g, "").split("\n").reverse()) {
    const match = line.match(/^\s*❯(?:\u00a0|[ \t])?(.*)$/);
    if (!match) continue;
    let dim = false, invalid = false, text = "";
    for (const part of match[1].split(/(\x1b\[[0-9;]*m)/)) {
      const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
      if (sgr) {
        const codes = sgr[1] ? sgr[1].split(";") : ["0"];
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === "38" || code === "48" || code === "58") {
            i += codes[i + 1] === "5" ? 2 : codes[i + 1] === "2" ? 4 : 0;
          } else if (code === "0" || code === "22") dim = false;
          else if (code === "2") dim = true;
        }
      } else if (part.trim()) {
        if (!dim) invalid = true;
        text += part;
      } else if (dim) text += part;
    }
    const suggestion = text.trim();
    if (suggestion && !invalid) return suggestion;
    return null;
  }
  return null;
}

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
export async function promptFrom(pane: string, plain: string, blocked: boolean, ansiScreen?: string): Promise<Prompt | { raw: string } | null> {
  const p = parsePrompt(plain);
  if (!p) return blocked && plain.trim() ? { raw: plain } : null;
  if (!p.tabs.length) return p;
  const ansi = ansiScreen ?? String(await herdr("agent", "read", pane, "--source", "visible", "--lines", "60", "--format", "ansi").catch(() => "")); // the active tab is only visible in colour
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
