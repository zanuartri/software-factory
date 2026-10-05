// One policy for every harness. CLI mode = PreToolUse hook (claude, commandcode); import mode = omp extension.
// No FACTORY_RUN_ID in env → not a factory worker → allow everything.
import { isAbsolute, relative, resolve } from "node:path";

/** `scope` is advisory (gate + reviewer look at it); the guard only blocks what is unsafe: secrets, other worktrees, outside the worktree, publishing, the daemon API. */
export type GuardCtx = { worktree: string; scope: string[]; role: "worker" | "reviewer" };
export type Verdict = { allow: true } | { allow: false; reason: string };

const SECRET = /(^|[\\/])(\.env(\..*)?|id_rsa[^\\/]*|\.ssh|\.aws|\.npmrc|auth\.json|credentials(\.json)?|factory\.db)$/i;
const API_WHY = "the factory daemon API is off-limits from the shell; use the factory tools";
const API_RE = /FACTORY_URL|\/api\/(ws|runs)\//;
// read-only source searches may mention daemon strings; any HTTP client in the command voids the exemption
const SEARCH = /\b(?:rg|grep|git\s+grep|git\s+log|findstr|select-string)\b/i;
const HTTP_CLIENT = /\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b|fetch\(|https?\.get|\bnc\s|\bncat\b/i;
const API_HOSTS = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0", "127.1"];
const SHELL_DENY: [RegExp, string][] = [
  [/\bgit\s+push\b/, "pushing is done by the factory after review"],
  [/\bgit\s+(rebase|worktree|switch)\b|\bgit\s+checkout\s+-b\b|\bgit\s+branch\s+-[dD]\b/, "branch/worktree management belongs to the daemon"],
  [/--force\b|--no-verify\b/, "force / skip-hooks flags are forbidden"],
  [/\bgh\s+(pr\s+merge|release|repo\s+delete)\b|\bnpm\s+publish\b|\bbun\s+publish\b/, "publishing/merging is not a worker action"],
  [/\bsudo\b|\|\s*(sh|bash|pwsh|powershell)\b/, "privilege escalation / pipe-to-shell is forbidden"],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\.|[A-Za-z]:[\\/])(\s|$)/, "recursive delete outside the worktree"],
];

export function kind(tool: string): "write" | "shell" | "read" | "other" {
  const t = tool.toLowerCase();
  if (/write|edit|patch|create|notebook|multiedit/.test(t)) return "write";
  if (/bash|shell|exec|command|terminal/.test(t)) return "shell";
  if (/read|view|cat/.test(t)) return "read";
  return "other";
}

const pathOf = (input: any): string | undefined => input?.file_path ?? input?.filePath ?? input?.path ?? input?.notebook_path;

/** Portable glob → RegExp (extensions load in the harness runtime, hooks on bun): supports ** * ? {a,b}. */
export function globRe(g: string) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = g.indexOf("}", i); re += `(?:${g.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function inScope(rel: string, scope: string[]) {
  const p = rel.replace(/\\/g, "/");
  return scope.some((raw) => {
    const g = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    return globRe(g).test(p) || globRe(`${g}/**`).test(p); // plain "src/auth" means the whole dir
  });
}

export function check(tool: string, input: any, ctx: GuardCtx): Verdict {
  const k = kind(tool);
  const deny = (reason: string): Verdict => ({ allow: false, reason: `factory guard: ${reason}. If you truly need this, call factory_ask.` });
  const virtual = (p: unknown) => typeof p === "string" && /^[a-z][a-z0-9+.-]+:/i.test(p); // a 1-letter prefix is a Windows drive // harness-internal URIs (omp: local://, xd://, skill://) aren't files

  if (k === "read" || k === "write") {
    const p = pathOf(input);
    if (!p || virtual(p)) return { allow: true };
    const abs = isAbsolute(p) ? p : resolve(ctx.worktree, p);
    if (SECRET.test(abs)) return deny(`secret-looking path ${p}`);
    // sibling tickets' worktrees live next to ours (~/.factory/worktrees/<ws>/<ticket>): one writer per worktree, and no peeking
    const worktreesRoot = resolve(ctx.worktree, "..", "..");
    const relRoot = relative(worktreesRoot, abs);
    const relOwn = relative(ctx.worktree, abs);
    if (!relRoot.startsWith("..") && !isAbsolute(relRoot) && (relOwn.startsWith("..") || isAbsolute(relOwn))) return deny(`${p} belongs to another ticket's worktree`);
    if (k === "read") return { allow: true };
    if (ctx.role === "reviewer") return deny("reviewers are read-only");
    const rel = relative(ctx.worktree, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return deny(`${p} is outside your worktree`);
    return { allow: true };
  }
  if (k === "shell") {
    const cmd = String(input?.command ?? input?.cmd ?? "");
    for (const [re, why] of SHELL_DENY) if (re.test(cmd)) return deny(why);
    const url = process.env.FACTORY_URL, ports = new Set([process.env.FACTORY_PORT]);
    try { if (url) ports.add(new URL(url).port); } catch {}
    if (!(SEARCH.test(cmd) && !HTTP_CLIENT.test(cmd))) {
      if (API_RE.test(cmd) || (url && cmd.includes(url))) return deny(API_WHY);
      for (const p of ports) if (p && API_HOSTS.some((h) => cmd.includes(`${h}:${p}`))) return deny(API_WHY);
    }
    if (ctx.role === "reviewer" && /\bgit\s+(commit|add|reset|stash|merge)\b|>\s*[^&|]/.test(cmd)) return deny("reviewers are read-only");
    if (cmd.split(/\s+/).some((w) => SECRET.test(w.replace(/["']/g, "")))) return deny("command touches a secret-looking path");
    return { allow: true };
  }
  return { allow: true };
}

export function ctxFromEnv(): GuardCtx | null {
  if (!process.env.FACTORY_RUN_ID) return null;
  return {
    worktree: process.env.FACTORY_WORKTREE!,
    scope: JSON.parse(process.env.FACTORY_SCOPE ?? "[]"),
    role: (process.env.FACTORY_ROLE as any) ?? "worker",
  };
}

export async function reportBlock(tool: string, reason: string) {
  const url = process.env.FACTORY_URL, run = process.env.FACTORY_RUN_ID, token = process.env.FACTORY_TOKEN;
  if (!url || !run) return;
  await fetch(`${url}/api/runs/${run}/guard`, {
    method: "POST", headers: { "content-type": "application/json", "x-factory-token": token ?? "" },
    body: JSON.stringify({ tool, reason }), signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
