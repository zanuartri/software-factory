#!/usr/bin/env bun
// `factory` CLI — the coordinator's hands. Talks to factoryd over HTTP; starts it when it is down.
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE_URL, HOME } from "./db";
import { repoRoot } from "./git";
import { ROOT } from "./prompts";

const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
  } else pos.push(a);
}
const asJson = !!flags.json;
const out = (human: string, data?: unknown) => console.log(asJson && data !== undefined ? JSON.stringify(data, null, 2) : human);
const die = (msg: string): never => { console.error(`factory: ${msg}`); process.exit(1); };

async function alive() {
  return fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
}
async function up() {
  if (await alive()) return;
  mkdirSync(HOME, { recursive: true });
  const log = openSync(join(HOME, "daemon.log"), "a");
  const p = Bun.spawn(["bun", join(ROOT, "src", "daemon.ts")], { stdio: ["ignore", log, log], detached: true, cwd: ROOT, windowsHide: true });
  p.unref();
  for (let i = 0; i < 40; i++) { if (await alive()) return; await Bun.sleep(250); }
  die(`daemon did not start; see ${join(HOME, "daemon.log")}`);
}
async function api(method: string, path: string, body?: unknown, raw = false) {
  await up();
  const res = await fetch(BASE_URL + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  if (raw) return res.text();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${data.error ?? res.status}${data.brief_errors ? "\n  - " + data.brief_errors.join("\n  - ") : ""}`);
  return data;
}

/** The workspace for cwd, or null (callers that need one use currentWs, which exits with a hint). */
async function findWs(): Promise<{ id: string; path: string } | null> {
  if (typeof flags.ws === "string") return { id: flags.ws, path: "" };
  const root = repoRoot(process.cwd());
  if (!root) return null;
  const all = (await api("GET", "/api/workspaces")) as any[];
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  // worktrees live under ~/.factory/worktrees/<ws>/<ticket>
  const viaWt = norm(root).match(/\/worktrees\/([^/]+)\/t-\d+$/)?.[1];
  return all.find((w) => norm(w.path) === norm(root)) ?? all.find((w) => w.id === viaWt) ?? null;
}
async function currentWs(): Promise<{ id: string; path: string }> {
  return (await findWs()) ?? die(repoRoot(process.cwd()) ? "this repo is not a factory workspace — run `factory init` (or /factory:init)" : "not inside a git repo (or pass --ws <id>)");
}
const kv = (pairs: string[]) => Object.fromEntries(pairs.map((p) => {
  const [k, ...v] = p.split("="); const val = v.join("=");
  if (["tags", "depends_on", "scope_paths"].includes(k)) return [k, val ? val.split(",").map((s) => s.trim()) : []];
  if (val === "" || val === "null") return [k, null];
  return [k, val];
}));
const line = (t: any) => `${t.id.padEnd(6)} ${t.status.padEnd(11)} ${(t.priority ?? "").padEnd(3)} ${t.blocked ? "⛔" : t.failed ? "✖" : " "} ${t.title}${t.blocked ? `  (blocked: ${t.blocked})` : ""}${t.failed ? `  (failed: ${t.failed})` : ""}`;
const cursorFile = (ws: string) => join(HOME, `cursor-${ws}`);

function fmtEvent(e: any) {
  const d = e.data ?? {};
  const who = [e.ticket, e.run].filter(Boolean).join(" ");
  switch (e.type) {
    case "ask": return `❓ ask #${d.id} ${who}${d.irreversible ? " [IRREVERSIBLE]" : ""}\n   ${d.question}\n   options: ${(d.options ?? []).join(" | ")}  default: ${d.default}\n   → factory answer ${d.id} "<answer>"`;
    case "gate.passed": return `✅ ${e.ticket} passed the gate (attempt ${d.attempt}) → in_review`;
    case "ticket.failed": return `✖ ${e.ticket} failed: ${d.reason}`;
    case "ticket.blocked": return `⛔ ${e.ticket} blocked: ${d.reason}\n   → factory tell ${e.ticket} "<guidance>"`;
    case "run.stuck": return `🐢 ${who} no heartbeat for ${d.minutes}m`;
    case "run.timebox": return `⏰ ${e.ticket} timebox (${d.minutes}m) expired — told to wrap up`;
    case "run.died": return `💀 ${who} process died (${d.code ?? d.reason})`;
    case "plan.drained": return `🏁 run finished — in_review: [${d.in_review}] blocked: [${d.blocked}] failed: [${d.failed}] open left: [${d.open_left}]${d.budget_exhausted ? " (budget exhausted)" : ""}`;
    case "merge.conflict": return `⚔ ${e.ticket} conflicts with base in ${d.files.join(", ")} — worker resumed to resolve`;
    case "merge.verify_failed": return `✖ ${e.ticket} fails \`${d.cmd}\` after merging base — worker resumed`;
    case "merge.reverted": return `↩ ${e.ticket} auto-reverted (${d.revert}) — base verify failed`;
    case "merge.done": return `🚢 ${e.ticket} merged ${d.sha?.slice(0, 8)}`;
    default: return `• ${e.type} ${who} ${JSON.stringify(d)}`;
  }
}

const [cmd, sub, ...rest] = pos;
switch (cmd) {
  case "up": await up(); out(`factoryd up at ${BASE_URL}`); break;
  case "down": {
    const h = await fetch(`${BASE_URL}/health`).then((r) => r.json()).catch(() => null);
    if (h) {
      await fetch(`${BASE_URL}/api/shutdown`, { method: "POST" }).catch(() => {}); // kills worker trees first
      await Bun.sleep(600);
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(h.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
      else try { process.kill(h.pid); } catch {}
    }
    out(h ? "stopped (workers stopped too; `factory tell <ticket>` resumes them)" : "not running");
    break;
  }
  case "ui": await up(); out(BASE_URL); Bun.spawn(process.platform === "win32" ? ["cmd", "/c", "start", "", BASE_URL] : ["open", BASE_URL]); break;

  case "init": {
    const w = await api("POST", "/api/workspaces", { path: process.cwd() });
    if (flags.session) await api("POST", `/api/ws/${w.id}/attach`, { session: flags.session, force: !!flags.force });
    const s = await api("GET", `/api/ws/${w.id}`);
    out(`workspace ${w.id} → ${w.path}\ncoordinator: ${flags.session ?? s.coordinator ?? "-"}\nbase: ${s.settings.base_branch}\nfiles: ${join(w.path, ".factory")}/{rules.md,settings.json,verify.md,tickets/,issues/}\nui: ${BASE_URL}`, s);
    break;
  }
  case "attach": { const w = await currentWs(); await api("POST", `/api/ws/${w.id}/attach`, { session: sub ?? flags.session, force: !!flags.force }); out(`attached as coordinator of ${w.id}`); break; }

  case "status": {
    const w = await currentWs();
    const [info, tickets, runs, asks] = await Promise.all([api("GET", `/api/ws/${w.id}`), api("GET", `/api/ws/${w.id}/tickets`), api("GET", `/api/ws/${w.id}/runs`), api("GET", `/api/ws/${w.id}/asks`)]);
    const live = runs.filter((r: any) => ["starting", "running", "idle", "gating", "paused"].includes(r.status));
    const pending = asks.filter((a: any) => a.answer == null);
    const by = (s: string) => tickets.filter((t: any) => t.status === s).length;
    out([
      `${info.name}  base=${info.settings.base_branch}  workers ${live.filter((r: any) => r.role === "worker").length}/${info.settings.max_workers}  plan=${info.plan?.active ? info.plan.mode : "idle"}`,
      `board: draft ${by("draft")} · open ${by("open")} · in_progress ${by("in_progress")} · in_review ${by("in_review")} · done ${by("done")}`,
      "", "live runs:", ...(live.length ? live.map((r: any) => `  ${r.id} ${r.ticket} ${r.role} ${r.harness}${r.model ? "/" + r.model : ""} ${r.status}/${r.phase ?? "-"} try${r.attempt} — ${r.summary ?? ""}`) : ["  (none)"]),
      "", "pending asks:", ...(pending.length ? pending.map((a: any) => `  #${a.id} ${a.ticket}: ${a.question} (default: ${a.default_answer})`) : ["  (none)"]),
      "", "tickets needing attention:", ...tickets.filter((t: any) => t.blocked || t.failed || t.status === "in_review").map((t: any) => "  " + line(t)),
    ].join("\n"), { info, tickets, live, pending });
    break;
  }

  case "ticket": {
    const w = await currentWs();
    if (sub === "new") {
      const t = await api("POST", `/api/ws/${w.id}/tickets`, { title: (flags.title as string) || rest.join(" ") || die("--title required"), issue: flags.issue, harness: flags.harness, priority: flags.priority, tags: typeof flags.tags === "string" ? flags.tags.split(",") : undefined });
      out(`${t.id} ${t.file}`, t);
    } else if (sub === "list" || !sub) {
      const ts = (await api("GET", `/api/ws/${w.id}/tickets`)).filter((t: any) => !flags.status || t.status === flags.status);
      out(ts.map(line).join("\n") || "(no tickets)", ts);
    } else if (sub === "show") {
      const t = await api("GET", `/api/ws/${w.id}/tickets/${rest[0]}`);
      out(`${line(t)}\nfile: ${t.file}\nbranch: ${t.branch ?? "-"}\nbrief errors: ${t.brief_errors.join("; ") || "none"}\nruns: ${t.runs.map((r: any) => `${r.id}(${r.role} ${r.harness} ${r.status})`).join(", ") || "-"}\n\n${Object.entries(t.sections).map(([k, v]) => `## ${k}\n${v}`).join("\n\n")}`, t);
    } else if (sub === "move") {
      const t = await api("PATCH", `/api/ws/${w.id}/tickets/${rest[0]}`, { status: rest[1] });
      out(line(t), t);
    } else if (sub === "set") {
      const t = await api("PATCH", `/api/ws/${w.id}/tickets/${rest[0]}`, kv(rest.slice(1)));
      out(line(t), t);
    } else die("ticket new|list|show|move|set");
    break;
  }
  case "issue": {
    const w = await currentWs();
    if (sub === "new") {
      const body = typeof flags.body === "string" ? flags.body : process.stdin.isTTY ? "" : await Bun.stdin.text();
      const i = await api("POST", `/api/ws/${w.id}/issues`, { title: flags.title ?? rest.join(" "), body, kind: flags.kind, tags: typeof flags.tags === "string" ? flags.tags.split(",") : undefined });
      out(`${i.id} ${i.file}`, i);
    } else if (sub === "list" || !sub) {
      const is = (await api("GET", `/api/ws/${w.id}/issues`)).filter((i: any) => !flags.status || i.status === flags.status);
      out(is.map((i: any) => `${i.id.padEnd(6)} ${i.status.padEnd(9)} ${i.kind.padEnd(8)} ${i.title}${i.tickets.length ? `  → ${i.tickets.join(",")}` : ""}`).join("\n") || "(no issues)", is);
    } else if (sub === "set") {
      const patch = kv(rest.slice(1));
      if (typeof patch.tickets === "string") patch.tickets = (patch.tickets as string).split(",");
      const i = await api("PATCH", `/api/ws/${w.id}/issues/${rest[0]}`, patch);
      out(`${i.id} ${i.status} ${i.title}`, i);
    } else die("issue new|list|set");
    break;
  }

  case "run": {
    const w = await currentWs();
    const p = await api("POST", `/api/ws/${w.id}/run`, { only: [sub, ...rest].filter(Boolean).length ? [sub, ...rest].filter(Boolean) : undefined, hours: flags.hours ? Number(flags.hours) : undefined, maxTickets: flags.max ? Number(flags.max) : undefined, mode: flags.auto ? "auto" : "run" });
    out(`plan started (${p.mode}) — spawning stops at ${new Date(p.spawnStopAt).toLocaleTimeString()}, max ${p.maxTickets === 1e9 ? "∞" : p.maxTickets} tickets. Now: factory wait`, p);
    break;
  }
  case "stop": { const w = await currentWs(); await api("POST", `/api/ws/${w.id}/stop`); out("plan stopped (running workers continue; use factory kill to stop them)"); break; }

  case "wait": {
    const w = await currentWs();
    const since = existsSync(cursorFile(w.id)) ? Number(readFileSync(cursorFile(w.id), "utf8")) : 0;
    const res = await api("GET", `/api/ws/${w.id}/wait?since=${flags.since ?? since}&timeout=${flags.timeout ?? 1800}`);
    writeFileSync(cursorFile(w.id), String(res.cursor));
    out(res.events.length ? res.events.map(fmtEvent).join("\n") : "(no coordinator events — still working; run `factory wait` again)", res);
    break;
  }
  case "tell": { const w = await currentWs(); await api("POST", `/api/ws/${w.id}/tickets/${sub}/tell`, { text: rest.join(" "), abort: !!flags.abort }); out(`→ ${sub}${flags.abort ? " (abort + resume)" : ""}`); break; }
  case "answer": { await api("POST", `/api/asks/${sub}/answer`, { answer: rest.join(" "), by: "coordinator" }); out(`answered #${sub}`); break; }
  case "asks": { const w = await currentWs(); const a = (await api("GET", `/api/ws/${w.id}/asks`)).filter((x: any) => flags.all || x.answer == null); out(a.map((x: any) => `#${x.id} ${x.ticket} ${x.irreversible ? "[IRREVERSIBLE] " : ""}${x.question}\n    options: ${x.options}  default: ${x.default_answer}${x.answer ? `  answered: ${x.answer} (${x.answered_by})` : ""}`).join("\n") || "(none)", a); break; }
  case "runs": { const w = await currentWs(); const r = await api("GET", `/api/ws/${w.id}/runs`); out(r.slice(0, 30).map((x: any) => `${x.id} ${x.ticket} ${x.role.padEnd(8)} ${x.harness.padEnd(11)} ${x.status.padEnd(8)} ${x.phase ?? ""} ${x.summary ?? ""}`).join("\n"), r); break; }
  case "log": { const r = await api("GET", `/api/runs/${sub}`); out(`${r.dir}\n\n## decisions\n${r.decisions}\n## report\n${r.report || "-"}\n## evidence\n${r.evidence.join("\n")}`, r); break; }
  case "steer": { await api("POST", `/api/runs/${sub}/steer`, { text: rest.join(" ") }); out("steered"); break; }
  case "abort": { await api("POST", `/api/runs/${sub}/abort`, { text: rest.join(" ") || undefined }); out("aborted"); break; }
  case "kill": { await api("POST", `/api/runs/${sub}/kill`); out("killed"); break; }
  case "diff": { const w = await currentWs(); out(await api("GET", `/api/ws/${w.id}/tickets/${sub}/diff`, undefined, true)); break; }
  case "merge": { const w = await currentWs(); const r = await api("POST", `/api/ws/${w.id}/tickets/${sub}/merge`); out(`${sub}: ${r.status}${r.sha ? " " + r.sha.slice(0, 8) : ""}${r.files ? " conflicts: " + r.files.join(", ") : ""}`, r); break; }
  case "gc": { const w = await currentWs(); const a = await api("POST", `/api/ws/${w.id}/gc`, { dry: !flags.apply }); out((a.map((x: any) => `${flags.apply ? "removed" : "would remove"} ${x.kind} ${x.target} — ${x.why}`).join("\n") || "nothing to clean") + (flags.apply || !a.length ? "" : "\n(dry run — pass --apply)"), a); break; }
  case "doctor": {
    const ws = (await findWs())?.id; // doctor works anywhere; outside a workspace it checks all of them
    const c = await api("GET", `/api/doctor${ws ? `?ws=${ws}` : ""}`);
    out(c.map((x: any) => `${x.ok ? "✔" : "✖"} ${x.name}${x.detail ? `  — ${x.detail}` : ""}`).join("\n"), c);
    break;
  }
  case "settings": {
    const w = await currentWs();
    if (sub === "set") { const patch = JSON.parse(rest.join(" ")); out(JSON.stringify(await api("PUT", `/api/ws/${w.id}/settings`, patch), null, 2)); }
    else out(JSON.stringify(await api("GET", `/api/ws/${w.id}/settings`), null, 2));
    break;
  }
  case "setup": {
    // global, env-gated guards: they no-op unless FACTORY_RUN_ID is set, so normal sessions are unaffected
    const guard = `bun "${join(ROOT, "src", "guard-hook.ts").replace(/\\/g, "/")}"`;
    const ccPath = join(homedir(), ".commandcode", "settings.json");
    const cc = existsSync(ccPath) ? JSON.parse(readFileSync(ccPath, "utf8")) : {};
    cc.hooks ??= {}; cc.hooks.PreToolUse ??= [];
    cc.hooks.PreToolUse = cc.hooks.PreToolUse.filter((h: any) => !JSON.stringify(h).includes("guard-hook.ts"));
    cc.hooks.PreToolUse.push({ matcher: ".*", hooks: [{ type: "command", command: guard }] });
    mkdirSync(join(homedir(), ".commandcode"), { recursive: true });
    writeFileSync(ccPath, JSON.stringify(cc, null, 2));
    const ocDir = join(homedir(), ".config", "opencode", "plugins");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(join(ocDir, "factory-guard.ts"), `export { FactoryGuard } from ${JSON.stringify(join(ROOT, "harness", "opencode-plugin.ts").replace(/\\/g, "/"))};\n`);
    out(`installed commandcode guard hook → ${ccPath}\ninstalled opencode guard plugin → ${join(ocDir, "factory-guard.ts")}\n\nClaude Code plugin:\n  claude plugin marketplace add ${ROOT}\n  claude plugin install factory@software-factory`);
    break;
  }
  default:
    out(`factory <command>
  up | down | ui | setup | doctor
  init [--session ID] [--force]      register this repo + attach coordinator
  status                             board, live runs, pending asks
  ticket new|list|show|move|set      tickets in .factory/tickets
  issue new|list|set                 issues in .factory/issues
  run [T-1 ...] [--auto --hours N --max N]   schedule open tickets onto workers
  stop                               stop scheduling new work
  wait [--timeout S]                 block until coordinator events (asks, gate results, blocked, drained)
  tell T-1 "msg" [--abort]           steer / interrupt / resume a ticket's worker
  answer <askId> "answer" | asks     worker questions
  runs | log <run> | steer|abort|kill <run>
  diff T-1 | merge T-1 | gc [--apply] | settings [set '{json}']`);
}
