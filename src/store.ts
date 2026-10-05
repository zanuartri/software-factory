// <repo>/.factory is the git-tracked source of truth for tickets, issues, rules and settings.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness } from "./db";

export const STATUSES = ["draft", "open", "in_progress", "in_review", "done"] as const;
export type Status = (typeof STATUSES)[number];
export const ISSUE_STATUSES = ["open", "triaged", "ticketed", "stale", "closed"] as const;

export type Ticket = {
  id: string; title: string; status: Status; priority: "p0" | "p1" | "p2" | "p3";
  tags: string[]; depends_on: string[]; scope_paths: string[];
  harness: Harness | "any"; model: string; difficulty: "low" | "medium" | "high"; blocked?: string | null; failed?: string | null;
  issue?: string | null; branch?: string | null; attempts?: number; created: string;
  sections: Record<string, string>; file: string;
};
export type Issue = {
  id: string; title: string; status: (typeof ISSUE_STATUSES)[number]; kind: "bug" | "feature" | "chore";
  tags: string[]; tickets: string[]; created: string; reason?: string | null; body: string; file: string;
};

export const SECTIONS = ["Goal", "Context", "Acceptance", "Verify", "Timebox", "Forbidden", "Report"] as const;

export const DEFAULT_SETTINGS = {
  base_branch: "main",
  /** models = the ones enabled for pickers (default, reviewer, per-ticket); empty = only the harness default */
  harnesses: {
    claude: { enabled: true, model: "sonnet", models: ["sonnet", "opus", "haiku"] },
    pi: { enabled: true, model: "", models: [] },
    commandcode: { enabled: false, model: "", models: [] },
  } as Record<Harness, { enabled: boolean; model: string; models: string[] }>,
  default_harness: "claude" as Harness,
  max_workers: 3,
  reviewer_order: ["pi", "commandcode", "claude"] as Harness[],
  reviewer_models: { claude: "opus", pi: "", commandcode: "" } as Record<Harness, string>,
  verify_cmd: "",
  /** cost-first routing: keyed "<harness>:<model>"; empty = today's pickHarness/pickReviewer behavior unchanged */
  catalog: {} as Record<string, { cost: number; quality: number; family: string; caps?: string[] }>,
  /** claude permission allowlist for workers; the guard hook still vetoes push/force/out-of-scope */
  allowed_tools: ["Bash(git:*)", "Bash(bun:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(node:*)", "Bash(ls:*)",
    "Bash(cat:*)", "Bash(rg:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(mkdir:*)", "Bash(python:*)", "Bash(pytest:*)", "Bash(cargo:*)", "Bash(go:*)", "Bash(make:*)"],
  merge_via: "local" as "local" | "pr",
  auto_merge: true,
  auto_budget: { hours: 4, tickets: 10 },
  ask_timeout_min: 20,
  max_attempts: 3,
};
export type Settings = typeof DEFAULT_SETTINGS;

const dir = (repo: string, sub = "") => join(repo, ".factory", sub);

export function ensureLayout(repo: string) {
  for (const d of ["tickets", "issues"]) mkdirSync(dir(repo, d), { recursive: true });
  if (!existsSync(dir(repo, "settings.json"))) saveSettings(repo, DEFAULT_SETTINGS);
  if (!existsSync(dir(repo, "rules.md"))) writeFileSync(dir(repo, "rules.md"), "# Standing orders\n\n1. (run /factory:init to scan the repo)\n");
}

/** `<FACTORY_HOME>/catalog.json`, the same default db.ts uses — computed here to avoid the DB import side effect. */
const globalCatalogPath = () => join(process.env.FACTORY_HOME ?? join(homedir(), ".factory"), "catalog.json");
const isCatalog = (c: unknown): c is Settings["catalog"] => !!c && typeof c === "object" && !Array.isArray(c);

/** A missing, empty or unparsable global catalog means "no global catalog". */
function globalCatalog(): Settings["catalog"] {
  try { const c = JSON.parse(readFileSync(globalCatalogPath(), "utf8")); return isCatalog(c) ? c : {}; } catch { return {}; }
}

/** Set on the object `loadSettings` returns when the catalog was inherited, so `saveSettings` can drop it again.
 *  A symbol survives object spread (the settings PUT does `{ ...loadSettings(p), ...patch }`) but is skipped by
 *  JSON.stringify, so the mark itself never lands in a repo's settings.json. */
export const CATALOG_FROM_GLOBAL = Symbol("catalog inherited from the global catalog");

export function loadSettings(repo: string): Settings {
  const p = dir(repo, "settings.json");
  const raw = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const harnesses = Object.fromEntries(Object.entries(DEFAULT_SETTINGS.harnesses).map(([h, d]) => [h, { ...d, ...raw.harnesses?.[h] }])) as Settings["harnesses"];
  const own = isCatalog(raw.catalog) ? raw.catalog : {};
  const inherited = !Object.keys(own).length;
  const s = { ...DEFAULT_SETTINGS, ...raw, harnesses, catalog: inherited ? globalCatalog() : own };
  if (inherited) s[CATALOG_FROM_GLOBAL] = true;
  return s;
}

/** An inherited catalog is stripped here, so saving settings never copies the global one into a repo file. Only a
 *  catalog still identical to the global file is dropped: an explicit `catalog` in the patch is the user's and stays. */
export const saveSettings = (repo: string, s: Settings) =>
  writeFileSync(dir(repo, "settings.json"), JSON.stringify((s as any)[CATALOG_FROM_GLOBAL] && JSON.stringify(s.catalog) === JSON.stringify(globalCatalog()) ? { ...s, catalog: {} } : s, null, 2) + "\n");

/** PowerShell 5.1 strips embedded double quotes, so `["claude"]` arrives as `[claude]` and JSON.parse fails.
 *  When the current value (or the default at this key) is an array, fall back to a comma list (with or
 *  without brackets) instead of saving the raw string — `defaultVal` also heals an array setting that a
 *  pre-fix CLI corrupted into a string. */
function coerceValue(raw: string, currentVal: unknown, defaultVal?: unknown): unknown {
  if (Array.isArray(currentVal) || Array.isArray(defaultVal)) {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) return j; } catch {}
    let s = raw.trim();
    if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1).trim();
    return s === "" ? [] : s.split(",").map((x) => x.trim()).filter((x) => x !== "");
  }
  try { return JSON.parse(raw); } catch { return raw; }
}

/** CLI form for `factory settings set`: a single JSON arg (old behavior), or shell-safe `a.b.c=value` pairs
 *  (PowerShell can't pass embedded quotes). Nested keys deep-merge onto `current`; only touched top-level
 *  keys are returned so the daemon's shallow-merge PUT doesn't clobber sibling fields (e.g. other harnesses). */
export function settingsPatch(current: Settings, args: string[]): Partial<Settings> {
  const joined = args.join(" ").trim();
  if (joined.startsWith("{")) return JSON.parse(joined);
  const next: any = structuredClone(current);
  const touched = new Set<string>();
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq < 0) throw new Error(`invalid pair (missing '='): ${a}`);
    const parts = a.slice(0, eq).split(".");
    if (parts.some((p) => !p.trim())) throw new Error(`invalid pair (empty key): ${a}`);
    const rawVal = a.slice(eq + 1);
    if (!rawVal.trim()) throw new Error(`invalid pair (empty value): ${a}`);
    touched.add(parts[0]);
    let obj = next, def: any = DEFAULT_SETTINGS;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] !== "object" || obj[parts[i]] == null) obj[parts[i]] = {};
      obj = obj[parts[i]];
      def = def?.[parts[i]];
    }
    const leaf = parts.at(-1)!;
    obj[leaf] = coerceValue(rawVal, obj[leaf], def?.[leaf]);
  }
  return Object.fromEntries([...touched].map((k) => [k, next[k]]));
}
export const loadRules = (repo: string) => (existsSync(dir(repo, "rules.md")) ? readFileSync(dir(repo, "rules.md"), "utf8") : "");
export const saveRules = (repo: string, text: string) => writeFileSync(dir(repo, "rules.md"), text);

function parseMd(text: string): { fm: any; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  return { fm: Bun.YAML.parse(m[1]) ?? {}, body: m[2] };
}
// Hand-written so humans get `tags: [a, b]` in a stable order; JSON strings are valid YAML scalars.
const ORDER = ["id", "title", "status", "priority", "kind", "tags", "depends_on", "scope_paths", "harness", "model", "difficulty", "blocked", "failed", "issue", "tickets", "branch", "attempts", "reason", "created"];
const yv = (x: unknown): string =>
  Array.isArray(x) ? `[${x.map(yv).join(", ")}]`
  : x == null ? "null"
  : typeof x === "string" ? (/^[\w./@*-][\w ./@*-]*$/.test(x) && !/^(null|true|false|yes|no|[\d.]+)$/i.test(x) ? x : JSON.stringify(x))
  : String(x);
const fmString = (fm: Record<string, unknown>) => {
  const keys = [...ORDER.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !ORDER.includes(k))];
  return `---\n${keys.filter((k) => fm[k] !== undefined).map((k) => `${k}: ${yv(fm[k])}`).join("\n")}\n---\n`;
};

export function parseSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = "_";
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; out[cur] = ""; continue; }
    out[cur] = (out[cur] ?? "") + line + "\n";
  }
  for (const k in out) out[k] = out[k].trim();
  return out;
}
const renderSections = (s: Record<string, string>) =>
  [...SECTIONS.filter((k) => k in s), ...Object.keys(s).filter((k) => k !== "_" && !SECTIONS.includes(k as any))]
    .map((k) => `## ${k}\n${s[k] ?? ""}\n`).join("\n");

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function listMd(d: string) {
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => join(d, f)) : [];
}

/** `factory ticket set T-x attempts=1` sends a string, so the frontmatter can hold `attempts: "1"`. Keep it numeric
 *  in memory and on disk; anything non-numeric (or empty) is 0, matching the `?? 0` the spawn path already assumes. */
const num = (v: unknown) => Number(v) || 0;

export function readTicket(file: string): Ticket {
  const { fm, body } = parseMd(readFileSync(file, "utf8"));
  return {
    priority: "p2", tags: [], depends_on: [], scope_paths: [], harness: "any", model: "default", difficulty: "medium", status: "draft",
    ...fm, id: String(fm.id), attempts: "attempts" in fm ? num(fm.attempts) : undefined, sections: parseSections(body), file,
  };
}
export const listTickets = (repo: string) => listMd(dir(repo, "tickets")).map(readTicket).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
export const getTicket = (repo: string, id: string) => listTickets(repo).find((t) => t.id === id) ?? null;

export function writeTicket(t: Ticket) {
  const { sections, file, ...fm } = t;
  writeFileSync(file, fmString(fm) + "\n" + renderSections(sections));
}

function nextId(repo: string, prefix: string, sub: string) {
  const n = listMd(dir(repo, sub)).map((f) => Number(f.match(new RegExp(`${prefix}-(\\d+)`))?.[1] ?? 0));
  return `${prefix}-${String(Math.max(0, ...n) + 1).padStart(3, "0")}`;
}

export function createTicket(repo: string, input: Partial<Ticket> & { title: string }): Ticket {
  const id = nextId(repo, "T", "tickets");
  const t: Ticket = {
    id, title: input.title, status: "draft", priority: input.priority ?? "p2", tags: input.tags ?? [],
    depends_on: input.depends_on ?? [], scope_paths: input.scope_paths ?? [], harness: input.harness ?? "any",
    model: input.model ?? "default", difficulty: input.difficulty ?? "medium", issue: input.issue ?? null, created: new Date().toISOString(),
    sections: { Goal: "", Context: "", Acceptance: "- [ ] ", Verify: "", Timebox: "60m", Forbidden: "no push, no force, nothing outside scope_paths", Report: "", ...input.sections },
    file: dir(repo, `tickets/${id}-${slug(input.title)}.md`),
  };
  writeTicket(t);
  return t;
}

export function updateTicket(repo: string, id: string, patch: Partial<Ticket>) {
  const t = getTicket(repo, id);
  if (!t) throw new Error(`no ticket ${id}`);
  const next = { ...t, ...patch, sections: { ...t.sections, ...patch.sections }, id: t.id, file: t.file };
  if ("attempts" in patch) next.attempts = num(next.attempts);
  writeTicket(next);
  return next;
}

/** pstack: "the brief is the product" — a field you cannot fill is a unit you have not scoped. */
export function validateBrief(t: Ticket): string[] {
  const s = t.sections, errs: string[] = [];
  if (!s.Goal?.trim()) errs.push("Goal is empty");
  if (!/- \[[ x]\]\s*\S/.test(s.Acceptance ?? "")) errs.push("Acceptance needs at least one checkable '- [ ] item'");
  if (!s.Verify?.trim()) errs.push("Verify needs exact commands");
  if (!t.scope_paths.length) errs.push("scope_paths is empty");
  if (!/^\d+\s*(m|h)/.test(s.Timebox?.trim() ?? "")) errs.push("Timebox must look like 45m or 2h");
  return errs;
}

export const timeboxMs = (t: Ticket) => {
  const m = t.sections.Timebox?.match(/(\d+)\s*(m|h)/);
  return m ? Number(m[1]) * (m[2] === "h" ? 3600e3 : 60e3) : 3600e3;
};

export const verifyCommands = (t: Ticket) =>
  (t.sections.Verify ?? "").split(/\r?\n/).map((l) => l.replace(/^```\w*|```$/g, "").replace(/^\s*[-*$]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#"));

// ---- issues
export function readIssue(file: string): Issue {
  const { fm, body } = parseMd(readFileSync(file, "utf8"));
  return { kind: "bug", tags: [], tickets: [], status: "open", ...fm, id: String(fm.id), body: body.trim(), file };
}
export const listIssues = (repo: string) => listMd(dir(repo, "issues")).map(readIssue).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
export const getIssue = (repo: string, id: string) => listIssues(repo).find((i) => i.id === id) ?? null;
export function writeIssue(i: Issue) {
  const { body, file, ...fm } = i;
  writeFileSync(file, fmString(fm) + "\n" + body + "\n");
}
export function createIssue(repo: string, input: { title: string; body?: string; kind?: Issue["kind"]; tags?: string[] }): Issue {
  const id = nextId(repo, "I", "issues");
  const i: Issue = { id, title: input.title, status: "open", kind: input.kind ?? "bug", tags: input.tags ?? [], tickets: [], created: new Date().toISOString(), body: input.body ?? "", file: dir(repo, `issues/${id}-${slug(input.title)}.md`) };
  writeIssue(i);
  return i;
}
export function updateIssue(repo: string, id: string, patch: Partial<Issue>) {
  const i = getIssue(repo, id);
  if (!i) throw new Error(`no issue ${id}`);
  const next = { ...i, ...patch, id: i.id, file: i.file };
  writeIssue(next);
  return next;
}
