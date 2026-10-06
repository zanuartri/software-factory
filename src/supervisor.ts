import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ADAPTERS, killTree, type Handle, type NormEvent } from "./adapters";
import { BASE_URL, db, emit, getRun, getWs, HOME, updateRun, type Harness, type Run, type Workspace } from "./db";
import * as git from "./git";
import { inScope } from "./guard";
import { conflictPrompt, gateFailPrompt, reviewerPrompt, WORKER_MARK, workerPrompt } from "./prompts";
import * as store from "./store";

const handles = new Map<string, Handle>();
const verdictWaiters = new Map<string, (v: { verdict: "PASS" | "FAIL"; findings: string }) => void>();
const askWaiters = new Map<number, (answer: string) => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
const nudges = new Map<string, number>();
const remoteSnap = new Map<string, string>();
const submitted = new Set<string>();
/** Runs mid abort+resume on a one-process-per-turn adapter: the killed turn's late turn_end must not nudge the resume turn. */
const aborting = new Set<string>();

type Plan = { active: boolean; spawnStopAt: number; deadline: number; maxTickets: number; started: number; only?: string[]; mode: "run" | "auto" };
const plans = new Map<string, Plan>();

// ------------------------------------------------------------------ workspaces
export function registerWorkspace(path: string): Workspace {
  const root = git.repoRoot(path);
  if (!root) throw new Error(`${path} is not a git repository`);
  const existing = db.query("SELECT * FROM workspaces WHERE path=?").get(root) as Workspace | null;
  store.ensureLayout(root);
  if (existing) return existing;
  let id = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  while (getWs(id)) id += "-2";
  const s = store.loadSettings(root);
  const branch = git.currentBranch(root);
  if (branch && s.base_branch === "main" && !git.git(root, "rev-parse", "--verify", "main").ok) store.saveSettings(root, { ...s, base_branch: branch });
  db.query("INSERT INTO workspaces (id,name,path,created_at) VALUES (?,?,?,?)").run(id, basename(root), root, Date.now());
  emit(id, "workspace.registered", { path: root });
  return getWs(id)!;
}
export const listWorkspaces = () => db.query("SELECT * FROM workspaces ORDER BY name").all() as Workspace[];
export function attachManager(ws: string, session: string, force = false) {
  const w = mustWs(ws);
  const live = w.manager && w.manager !== session && Date.now() - (w.manager_seen ?? 0) < 10 * 60e3;
  if (live && !force) throw new Error(`workspace already has a live manager (${w.manager}); pass --force to take over`);
  db.query("UPDATE workspaces SET manager=?, manager_seen=? WHERE id=?").run(session, Date.now(), ws);
  emit(ws, "manager.attached", { session });
}
export const touchManager = (ws: string) => db.query("UPDATE workspaces SET manager_seen=? WHERE id=?").run(Date.now(), ws);
export function mustWs(ws: string) {
  const w = getWs(ws);
  if (!w) throw new Error(`unknown workspace ${ws}`);
  return w;
}
/** Unregister a workspace: refuses only while a run is really active (starting/running/gating — parked idle/paused leftovers don't block),
 *  stops and drops its plan, drops only the workspaces row (runs/events/asks stay, repo untouched). */
export function removeWorkspace(ws: string) {
  const w = mustWs(ws);
  const live = db.query("SELECT 1 FROM runs WHERE ws=? AND status IN ('starting','running','gating') LIMIT 1").get(w.id);
  if (live) throw new Error("workspace has active runs");
  if (planState(w.id)?.active) stopPlan(w.id);
  plans.delete(w.id); // no stale scheduling state left behind for a re-registered workspace
  db.query("DELETE FROM workspaces WHERE id=?").run(w.id);
  emit(w.id, "workspace.removed", { path: w.path });
  return w;
}

// ------------------------------------------------------------------ helpers
const runDir = (r: Pick<Run, "ws" | "ticket" | "id">) => join(HOME, "runs", r.ws, r.ticket, r.id);
const activeRuns = (ws: string) => db.query("SELECT * FROM runs WHERE ws=? AND status IN ('starting','running','idle','gating','paused')").all(ws) as Run[];
const activeWorkerFor = (ws: string, ticket: string) =>
  db.query("SELECT * FROM runs WHERE ws=? AND ticket=? AND role='worker' AND status IN ('starting','running','idle','gating','paused') ORDER BY started_at DESC").get(ws, ticket) as Run | null;
const lastWorkerFor = (ws: string, ticket: string) =>
  db.query("SELECT * FROM runs WHERE ws=? AND ticket=? AND role='worker' ORDER BY started_at DESC").get(ws, ticket) as Run | null;
const clearTimers = (id: string) => { for (const t of timers.get(id) ?? []) clearTimeout(t); timers.delete(id); };
const addTimer = (id: string, ms: number, fn: () => void) => timers.set(id, [...(timers.get(id) ?? []), setTimeout(fn, ms)]);

function decisionRow(r: Run, phase: string, a: { decision: string; why: string; evidence: string; result: string }) {
  const cell = (s: string) => String(s ?? "").replace(/[\t\r\n]+/g, " ").trim();
  appendFileSync(join(runDir(r), "decisions.tsv"), [new Date().toISOString(), phase, a.decision, a.why, a.evidence, a.result].map(cell).join("\t") + "\n");
  emit(r.ws, "run.decision", a, { ticket: r.ticket, run: r.id });
}

function pendingMessages(runId: string) {
  const rows = db.query("SELECT id, body FROM mailbox WHERE run=? AND delivered=0 ORDER BY id").all(runId) as { id: number; body: string }[];
  if (!rows.length) return "";
  db.query(`UPDATE mailbox SET delivered=1 WHERE id IN (${rows.map((r) => r.id).join(",")})`).run();
  return `\n\n📨 Messages from the manager (these override your plan — acknowledge with factory_decision):\n${rows.map((r) => `- ${r.body}`).join("\n")}`;
}

const SYSTEM32_BASH = /[\\/]windows[\\/]system32[\\/]/i;
let bashCache: string | undefined;

/**
 * Windows has two `bash`: Git Bash and `C:\WINDOWS\system32\bash.exe`, the WSL launcher — from a PowerShell-started
 * daemon PATH finds WSL first and every Verify dies with "execvpe(/bin/bash) failed". Git Bash lives at
 * `<git root>/bin/bash.exe` (or `usr/bin`), so walk up from the git on PATH instead of trusting PATH. Computed once.
 */
export function bashPath(): string {
  if (bashCache) return bashCache;
  if (process.platform !== "win32") return (bashCache = "bash");
  const git = Bun.which("git");
  const roots: string[] = [];
  if (git && !SYSTEM32_BASH.test(git)) for (let d = dirname(git); dirname(d) !== d; d = dirname(d)) roots.push(d);
  const found = roots.flatMap((r) => [join(r, "bin", "bash.exe"), join(r, "usr", "bin", "bash.exe")]).find((p) => existsSync(p) && !SYSTEM32_BASH.test(p));
  return (bashCache = found ?? "C:\\Program Files\\Git\\bin\\bash.exe");
}

async function sh(cmd: string, cwd: string, timeoutMs = 15 * 60e3) {
  const p = Bun.spawn([bashPath(), "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" }, windowsHide: true });
  const timer = setTimeout(() => killTree(p.pid), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, output: (out + (err ? `\n[stderr]\n${err}` : "")).slice(-20000) };
}

/** Two scope lists overlap if any literal prefix of one contains the other's. Conservative on purpose. */
export function scopesOverlap(a: string[], b: string[]) {
  const lit = (g: string) => g.replace(/\\/g, "/").replace(/^\.\//, "").split(/[*?[{]/)[0].replace(/\/$/, "");
  return a.some((x) => b.some((y) => { const p = lit(x), q = lit(y); return !p || !q || p === q || p.startsWith(q + "/") || q.startsWith(p + "/") || inScope(p, [y]) || inScope(q, [x]); }));
}

function pickHarness(s: store.Settings, t: store.Ticket, running: Run[]): Harness | null {
  const enabled = (h: Harness) => s.harnesses[h]?.enabled;
  const free = (h: Harness) => running.filter((r) => r.role === "worker" && r.harness === h && r.status !== "idle" && r.status !== "paused").length < ((s.harnesses[h] as any).max ?? s.max_workers);
  if (t.harness !== "any") return enabled(t.harness) && free(t.harness) ? t.harness : null;
  if (enabled(s.default_harness) && free(s.default_harness)) return s.default_harness;
  return (Object.keys(s.harnesses) as Harness[]).find((h) => enabled(h) && free(h)) ?? null;
}

const MIN_QUALITY = { low: 2, medium: 3, high: 4 } as const;

const QUALITY_TTL = 60e3;
const qualityCache = new Map<string, { passes: number; total: number; at: number }>();
/** A pass must see the outcomes it just produced, so clear the record at the start of every schedule pass. */
const clearQualityCache = () => qualityCache.clear();

/** Last 30 quality outcomes (worker runs only, all workspaces) for one catalog pair, cached ~60s / per pass.
 *  Stalls count as failures: a timebox, or a "stopped twice without factory_submit" block. Other blocked reasons stay neutral.
 *  A gate.failed counts only when it was the worker's fault (`ownFault`); rows written before that field existed still count. */
function gateRecord(key: string) {
  const hit = qualityCache.get(key);
  if (hit && Date.now() - hit.at < QUALITY_TTL) return hit;
  const i = key.indexOf(":");
  const rows = db.query(
    `SELECT e.type AS type FROM events e JOIN runs r ON r.id=e.run
     WHERE (e.type IN ('gate.passed','run.timebox') OR (e.type='gate.failed' AND json_extract(e.data,'$.ownFault') IS NOT 0)
       OR (e.type='ticket.blocked' AND e.data LIKE '%without factory_submit%'))
       AND r.role='worker' AND r.harness=? AND r.model=? ORDER BY e.id DESC LIMIT 30`,
  ).all(key.slice(0, i), key.slice(i + 1)) as { type: string }[];
  const rec = { passes: rows.filter((r) => r.type === "gate.passed").length, total: rows.length, at: Date.now() };
  qualityCache.set(key, rec);
  return rec;
}

/** Real track record beats the hand-written number: a pair below a 60% pass rate over >=5 gated runs is one level lower (floor 1). */
export function effectiveQuality(key: string, base: number): number {
  const { passes, total } = gateRecord(key);
  return total >= 5 && passes / total < 0.6 ? Math.max(1, base - 1) : base;
}

const PATH_TOKEN = /[\w./\\-]+\.\w+/g;

/** A gate failure demotes the pair only when the worker could have caused it: structural/reviewer findings always could,
 *  a failing verify counts only if its log tail names a file inside the ticket's scope (flaky timing and infra errors don't). */
export function ownFault(scopePaths: string[], verifyTails: string[], structuralOrReviewer: boolean): boolean {
  if (structuralOrReviewer) return true;
  return verifyTails.some((log) => (log.match(PATH_TOKEN) ?? []).some((tok) => inScope(tok.replace(/\\/g, "/").replace(/^\.\//, ""), scopePaths)));
}

let pickSeq = 0;
const lastPicked = new Map<string, number>(); // catalog key → seq, for round-robin among equal-cost ties

/** Cheapest catalog pair that meets the ticket's difficulty (escalated per retry) and tag-driven caps.
 *  Nothing qualifying is no reason to downgrade: with a catalog, the best free pair that satisfies the caps wins;
 *  only an empty catalog (or no free caps-satisfying pair at all) falls back to today's pickHarness + model logic. */
export function pickWorker(s: store.Settings, t: store.Ticket, running: Run[], attempt = 1): { harness: Harness; model: string } | null {
  const enabled = (h: Harness) => s.harnesses[h]?.enabled;
  const free = (h: Harness) => running.filter((r) => r.role === "worker" && r.harness === h && r.status !== "idle" && r.status !== "paused").length < ((s.harnesses[h] as any).max ?? s.max_workers);
  if (t.harness !== "any") {
    if (!enabled(t.harness) || !free(t.harness)) return null;
    return { harness: t.harness, model: t.model !== "default" ? t.model : s.harnesses[t.harness].model };
  }
  const minQuality = Math.min(5, (MIN_QUALITY[t.difficulty ?? "medium"] ?? 3) + (attempt - 1));
  const allCaps = new Set(Object.values(s.catalog).flatMap((c) => c.caps ?? []));
  const requiredCaps = t.tags.filter((tag) => allCaps.has(tag));
  const activeCount = (h: Harness) => running.filter((r) => r.role === "worker" && r.harness === h && r.status !== "idle" && r.status !== "paused").length;
  const pairs = Object.entries(s.catalog)
    .map(([key, c]) => ({ key, ...c, harness: key.slice(0, key.indexOf(":")) as Harness, model: key.slice(key.indexOf(":") + 1), quality: effectiveQuality(key, c.quality) }))
    .filter((c) => enabled(c.harness) && free(c.harness) && requiredCaps.every((tag) => (c.caps ?? []).includes(tag)));
  const candidates = pairs.filter((c) => c.quality >= minQuality);
  if (candidates.length) {
    candidates.sort((a, b) => a.cost - b.cost || activeCount(a.harness) - activeCount(b.harness) || (lastPicked.get(a.key) ?? 0) - (lastPicked.get(b.key) ?? 0));
    const pick = candidates[0];
    lastPicked.set(pick.key, ++pickSeq);
    return { harness: pick.harness, model: pick.model };
  }
  if (pairs.length) { // escalated past every pair's quality: take the best free one instead of dropping to the harness default
    pairs.sort((a, b) => b.quality - a.quality || a.cost - b.cost);
    const pick = pairs[0];
    lastPicked.set(pick.key, ++pickSeq);
    return { harness: pick.harness, model: pick.model };
  }
  const h = pickHarness(s, t, running);
  return h ? { harness: h, model: t.model !== "default" ? t.model : s.harnesses[h].model } : null;
}

export function pickReviewer(s: store.Settings, impl: { harness: Harness; model: string }): { harness: Harness; model: string } {
  const pin = s.reviewer.harness; // an explicit choice in settings wins over every heuristic below
  if (pin !== "auto" && s.harnesses[pin]?.enabled) return { harness: pin, model: s.reviewer.model || s.reviewer_models[pin] || s.harnesses[pin].model };
  if (Object.keys(s.catalog).length) {
    const implEntry = s.catalog[`${impl.harness}:${impl.model}`];
    const minQuality = Math.max(4, implEntry ? effectiveQuality(`${impl.harness}:${impl.model}`, implEntry.quality) : 0);
    const candidates = Object.entries(s.catalog)
      .map(([key, c]) => ({ key, ...c, harness: key.slice(0, key.indexOf(":")) as Harness, model: key.slice(key.indexOf(":") + 1) }))
      .filter((c) => s.harnesses[c.harness]?.enabled && effectiveQuality(c.key, c.quality) >= minQuality && (implEntry ? c.family !== implEntry.family : c.harness !== impl.harness))
      .sort((a, b) => a.cost - b.cost);
    if (candidates.length) return { harness: candidates[0].harness, model: candidates[0].model };
  }
  const h = s.reviewer_order.find((x) => x !== impl.harness && s.harnesses[x]?.enabled);
  if (h) return { harness: h, model: s.reviewer_models[h] || s.harnesses[h].model };
  return { harness: impl.harness, model: s.reviewer_models[impl.harness] || s.harnesses[impl.harness].model }; // same harness, different model (settings)
}

// ------------------------------------------------------------------ scheduling
export function startPlan(ws: string, o: { only?: string[]; hours?: number; maxTickets?: number; mode?: "run" | "auto" } = {}) {
  const w = mustWs(ws), s = store.loadSettings(w.path);
  const hours = o.hours ?? (o.mode === "auto" ? s.auto_budget.hours : 24);
  const now = Date.now();
  plans.set(ws, { active: true, deadline: now + hours * 3600e3, spawnStopAt: now + hours * 3600e3 * 0.7, maxTickets: o.maxTickets ?? (o.mode === "auto" ? s.auto_budget.tickets : 1e9), started: 0, only: o.only, mode: o.mode ?? "run" });
  emit(ws, "plan.started", { ...plans.get(ws), hours });
  schedule(ws);
  return plans.get(ws);
}
export function stopPlan(ws: string) {
  const p = plans.get(ws);
  if (p) p.active = false;
  emit(ws, "plan.stopped", {}, { manager: true });
}
export const planState = (ws: string) => plans.get(ws) ?? null;

const scheduling = new Map<string, boolean>(); // ws → rerun requested while a pass was in flight
export function schedule(ws: string) {
  if (scheduling.has(ws)) return void scheduling.set(ws, true);
  scheduling.set(ws, false);
  try { schedulePass(ws); } finally {
    const again = scheduling.get(ws);
    scheduling.delete(ws);
    if (again) schedule(ws);
  }
}

function schedulePass(ws: string) {
  const plan = plans.get(ws);
  if (!plan?.active) return;
  clearQualityCache(); // fresh track record for this pass, not the previous one's
  const w = mustWs(ws), s = store.loadSettings(w.path);
  const tickets = store.listTickets(w.path);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  let running = activeRuns(ws);
  const now = Date.now();
  const spawnAllowed = now < plan.spawnStopAt && plan.started < plan.maxTickets;
  const eligible = tickets
    .filter((t) => t.status === "open" && !t.blocked && !t.failed && (!plan.only || plan.only.includes(t.id)))
    .filter((t) => t.depends_on.every((d) => ["done", "in_review"].includes(byId.get(d)?.status ?? "")))
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id, undefined, { numeric: true }));

  for (const t of eligible) {
    if (!spawnAllowed) break;
    // parked runs (idle/paused: blocked, waiting on the manager) hold a worktree but no slot
    const workers = running.filter((r) => r.role === "worker" && r.status !== "idle" && r.status !== "paused");
    if (workers.length >= s.max_workers) break;
    const busy = workers.filter((r) => r.ticket !== t.id).map((r) => byId.get(r.ticket)).filter(Boolean) as store.Ticket[];
    if (busy.some((b) => scopesOverlap(b.scope_paths, t.scope_paths))) continue;
    const picked = pickWorker(s, t, running);
    if (!picked) continue;
    plan.started++;
    spawnWorker(ws, t.id, { harness: picked.harness, model: picked.model }).catch((e) => {
      store.updateTicket(w.path, t.id, { blocked: `spawn failed: ${e.message}` });
      emit(ws, "ticket.blocked", { reason: e.message }, { ticket: t.id, manager: true });
    });
    running = activeRuns(ws); // spawnWorker inserts its run row synchronously, before its first await
  }

  const stillWorking = activeRuns(ws).some((r) => r.role === "worker" && r.status !== "idle" && r.status !== "paused");
  const remaining = eligible.length && spawnAllowed;
  if (!stillWorking && !remaining) {
    plan.active = false;
    const all = store.listTickets(w.path).filter((t) => !plan.only || plan.only.includes(t.id));
    const count = (f: (t: store.Ticket) => boolean) => all.filter(f).map((t) => t.id);
    emit(ws, "plan.drained", {
      mode: plan.mode, in_review: count((t) => t.status === "in_review"), blocked: count((t) => !!t.blocked), failed: count((t) => !!t.failed),
      open_left: count((t) => t.status === "open" && !t.blocked && !t.failed), budget_exhausted: !spawnAllowed,
    }, { manager: true });
  }
}

// ------------------------------------------------------------------ spawning
export async function spawnWorker(ws: string, ticketId: string, o: { harness?: Harness; model?: string; resumeFrom?: Run; message?: string } = {}) {
  const w = mustWs(ws), s = store.loadSettings(w.path);
  const t = store.getTicket(w.path, ticketId);
  if (!t) throw new Error(`no ticket ${ticketId}`);
  const prev = activeWorkerFor(ws, ticketId);
  if (prev && !o.resumeFrom) {
    if (["running", "starting", "gating"].includes(prev.status)) throw new Error(`${ticketId} already has an active worker`);
    // parked (idle/paused) run of an earlier attempt: a fresh spawn supersedes it. No finishRun: it would re-enter schedule().
    const parked = db.query("SELECT id FROM runs WHERE ws=? AND ticket=? AND role='worker' AND status IN ('idle','paused')").all(ws, ticketId) as { id: string }[];
    for (const { id } of parked) { clearTimers(id); handles.get(id)?.kill(); handles.delete(id); updateRun(id, { status: "killed", ended_at: Date.now() }); }
  }
  const attempt = (o.resumeFrom?.attempt ?? t.attempts ?? 0) + (o.resumeFrom ? 0 : 1);
  const auto = o.resumeFrom || o.harness ? null : pickWorker(s, t, activeRuns(ws), attempt);
  const harness = o.resumeFrom?.harness ?? o.harness ?? auto?.harness ?? s.default_harness;
  if (!s.harnesses[harness]?.enabled) throw new Error(`harness ${harness} is disabled in settings`);
  const branch = t.branch ?? `factory/${t.id}-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/-$/, "")}`;
  const worktree = git.addWorktree(w.path, git.worktreePath(ws, t.id), branch, s.base_branch);
  const model = o.model ?? auto?.model ?? (t.model !== "default" ? t.model : s.harnesses[harness].model);
  const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const token = crypto.randomUUID();
  db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,phase,worktree,branch,attempt,token,started_at,heartbeat_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ws, t.id, "worker", harness, model || null, "starting", "plan", worktree, branch, attempt, token, Date.now(), Date.now(), o.resumeFrom?.session_id ?? null);
  const run = getRun(id)!;
  mkdirSync(runDir(run), { recursive: true });
  writeFileSync(join(runDir(run), "decisions.tsv"), "ts\tphase\tdecision\twhy\tevidence\tresult\n");
  store.updateTicket(w.path, t.id, { status: "in_progress", branch, attempts: attempt, blocked: null, failed: null });
  remoteSnap.set(id, git.remoteRefs(w.path));
  submitted.delete(id);

  const prompt = o.resumeFrom
    ? o.message ?? "Resume where you left off. Re-read the brief, check git log, continue, then factory_submit."
    : workerPrompt(t, store.loadRules(w.path), { branch, base: s.base_branch, attempt, worktree });
  await startAdapter(run, prompt, { resumeSession: o.resumeFrom?.session_id, allowedTools: s.allowed_tools });

  const tb = store.timeboxMs(t);
  addTimer(id, tb, () => {
    if (!isLive(id)) return;
    steer(id, "⏰ Timebox expired. Stop starting new work: commit what is verified, then factory_submit (ready if acceptance is met, otherwise blocked with partial findings) within 10 minutes.");
    emit(ws, "run.timebox", { minutes: tb / 60e3 }, { ticket: t.id, run: id, manager: true });
    // a worker that ignores the wrap-up is parked, not failed: its work is intact and `factory tell` resumes it
    addTimer(id, 10 * 60e3, () => isLive(id) && !submitted.has(id) && blockTicket(getRun(id)!, `timebox exceeded — resume with \`factory tell ${t.id}\``));
  });
  emit(ws, "run.started", { harness, model, attempt, branch }, { ticket: t.id, run: id });
  return getRun(id)!;
}

const isLive = (id: string) => ["starting", "running", "idle", "paused"].includes(getRun(id)?.status ?? "");

/** Test seam (abort.test.ts): starts ADAPTERS[harness] for an existing run row and registers its handle. */
export async function startAdapter(run: Run, prompt: string, extra: { resumeSession?: string | null; allowedTools?: string[] }) {
  const adapter = ADAPTERS[run.harness];
  const w = getWs(run.ws)!;
  const t = store.getTicket(w.path, run.ticket)!;
  // Every entry point converges here: a worker that starts without a session to resume must still get its brief.
  if (run.role === "worker" && !extra.resumeSession && !prompt.startsWith(WORKER_MARK)) {
    const s = store.loadSettings(w.path);
    prompt = `${workerPrompt(t, store.loadRules(w.path), { branch: run.branch!, base: s.base_branch, attempt: run.attempt, worktree: run.worktree! })}\n\n---\n# Message from the manager (read after the brief)\n${prompt}`;
  }
  if (!remoteSnap.has(run.id)) remoteSnap.set(run.id, git.remoteRefs(w.path)); // lost on daemon restart; never compare against nothing
  writeFileSync(join(runDir(run), `prompt-${Date.now()}.md`), prompt);
  const handle = await adapter.start({
    runId: run.id, role: run.role, cwd: run.worktree!, runDir: runDir(run), prompt, model: run.model ?? undefined,
    mcpUrl: `${BASE_URL}/mcp/${run.id}?t=${run.token}`, resumeSession: extra.resumeSession, allowedTools: extra.allowedTools,
    env: {
      FACTORY_URL: BASE_URL, FACTORY_RUN_ID: run.id, FACTORY_TOKEN: run.token, FACTORY_ROLE: run.role,
      FACTORY_WORKTREE: run.worktree!, FACTORY_SCOPE: JSON.stringify(t.scope_paths),
    },
    onEvent: (e) => onAdapterEvent(run.id, e),
  });
  handles.set(run.id, handle);
  updateRun(run.id, { status: "running", pid: handle.pid });
}

function onAdapterEvent(id: string, e: NormEvent) {
  const r = getRun(id);
  if (!r) return;
  const meta = { ticket: r.ticket, run: id };
  switch (e.type) {
    case "session": updateRun(id, { session_id: e.id }); break;
    case "text": emit(r.ws, "run.text", { text: e.text.slice(0, 4000) }, meta); updateRun(id, { heartbeat_at: Date.now() }); break;
    case "tool": emit(r.ws, "run.tool", { name: e.name, detail: e.detail }, meta); updateRun(id, { heartbeat_at: Date.now() }); break;
    case "turn_end": {
      if (e.usage) updateRun(id, { tokens: r.tokens + e.usage });
      if (!isLive(id) || r.status === "paused") return;
      if (aborting.has(id)) return; // the aborted turn's late result, not a real turn end — the resume turn owns the next one
      if (e.error) emit(r.ws, "run.error", { error: e.error }, meta);
      if (r.role === "reviewer" && verdictWaiters.has(id)) {
        const n = (nudges.get(id) ?? 0) + 1; nudges.set(id, n);
        if (n > 1) return verdictWaiters.get(id)!({ verdict: "FAIL", findings: "Reviewer ended without calling factory_verdict (treated as FAIL — rerun the gate)." });
        return void handles.get(id)?.send("You ended without calling factory_verdict. Call it now with PASS or FAIL.");
      }
      if (r.role === "worker" && !submitted.has(id)) {
        const n = (nudges.get(id) ?? 0) + 1; nudges.set(id, n);
        if (n > 2) return blockTicket(r, "worker stopped twice without factory_submit");
        updateRun(id, { status: "running" });
        return void handles.get(id)?.send("You ended your turn without factory_submit. If work remains, continue. If acceptance is met and committed, call factory_submit(status=ready). If you are stuck, factory_submit(status=blocked) with a write-up.");
      }
      if (r.status !== "gating") updateRun(id, { status: "idle" });
      break;
    }
    case "exit":
      handles.delete(id);
      if (isLive(id) && r.status !== "gating") {
        emit(r.ws, "run.died", { code: e.code }, { ...meta, manager: r.role === "worker" });
        if (r.role === "worker") blockTicket(r, `worker process exited (code ${e.code}) — resume with \`factory tell ${r.ticket}\``);
        else verdictWaiters.get(id)?.({ verdict: "FAIL", findings: `Reviewer process exited (code ${e.code}) without verdict.` });
      }
  }
}

function blockTicket(r: Run, reason: string) {
  const w = getWs(r.ws)!;
  store.updateTicket(w.path, r.ticket, { blocked: reason });
  finishRun(r.id, "idle");
  emit(r.ws, "ticket.blocked", { reason }, { ticket: r.ticket, run: r.id, manager: true });
  schedule(r.ws);
}

function finishRun(id: string, status: Run["status"], failReason?: string) {
  const r = getRun(id);
  if (!r) return;
  clearTimers(id);
  if (status !== "idle") { handles.get(id)?.kill(); handles.delete(id); }
  updateRun(id, { status, ended_at: status === "idle" ? null : Date.now() });
  if (status !== "idle") db.query("UPDATE asks SET answer='(run ended)', answered_by='expired' WHERE run=? AND answer IS NULL").run(id); // nobody is left to read the answer
  if (failReason && r.role === "worker") {
    store.updateTicket(getWs(r.ws)!.path, r.ticket, { failed: failReason });
    emit(r.ws, "ticket.failed", { reason: failReason }, { ticket: r.ticket, run: id, manager: true });
  }
  if (r.role === "worker") schedule(r.ws);
}

// ------------------------------------------------------------------ worker/reviewer tools
export async function callTool(runId: string, name: string, args: any): Promise<string> {
  const r = getRun(runId);
  if (!r) throw new Error("unknown run");
  const w = getWs(r.ws)!;
  const meta = { ticket: r.ticket, run: r.id };
  updateRun(runId, { heartbeat_at: Date.now() });
  switch (name) {
    case "factory_report":
      updateRun(runId, { phase: args.phase, summary: args.summary });
      emit(r.ws, "run.report", args, meta);
      return "ok" + pendingMessages(runId);
    case "factory_decision":
      decisionRow(r, r.phase ?? "-", args);
      return "logged" + pendingMessages(runId);
    case "factory_inbox":
      return (pendingMessages(runId) || "no messages").trim();
    case "factory_ask": {
      const s = store.loadSettings(w.path);
      const wait = Math.min(s.ask_timeout_min, 10) * 60e3;
      const { id } = db.query("INSERT INTO asks (ws,ticket,run,question,options,default_answer,irreversible,deadline,created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id")
        .get(r.ws, r.ticket, runId, args.question, JSON.stringify(args.options ?? []), args.default ?? null, args.irreversible ? 1 : 0, Date.now() + wait, Date.now()) as { id: number };
      emit(r.ws, "ask", { id, ...args }, { ...meta, manager: true });
      const answer = await new Promise<string | null>((res) => { askWaiters.set(id, res); setTimeout(() => res(null), wait); });
      askWaiters.delete(id);
      if (answer !== null) return `Answer: ${answer}` + pendingMessages(runId);
      if (args.irreversible) return `No answer yet to ask #${id}. Do NOT take the irreversible action. Continue other in-scope work; if nothing is left, factory_submit(status=blocked).` + pendingMessages(runId);
      db.query("UPDATE asks SET answer=?, answered_by='timeout' WHERE id=?").run(args.default, id);
      decisionRow(r, r.phase ?? "-", { decision: `took default: ${args.default}`, why: `ask #${id} unanswered after ${wait / 60e3}m (never block on the human)`, evidence: `ask #${id}`, result: "open" });
      emit(r.ws, "ask.timeout", { id, default: args.default }, meta);
      return `No answer within ${wait / 60e3} min — proceed with your default: ${args.default} (logged).` + pendingMessages(runId);
    }
    case "factory_submit": {
      if (r.role !== "worker") throw new Error("only workers submit");
      submitted.add(runId);
      writeFileSync(join(runDir(r), "report.md"), args.report ?? "");
      if (args.status === "blocked") {
        store.updateTicket(w.path, r.ticket, { sections: { Report: args.report } } as any);
        blockTicket(r, (args.report ?? "").split("\n").find((l: string) => l.trim()) ?? "blocked by worker");
        return "Recorded as blocked. End your turn now; the manager will reply.";
      }
      updateRun(runId, { status: "gating", phase: "gate" });
      gate(runId, args.report ?? "").catch((e) => {
        emit(r.ws, "gate.error", { error: String(e) }, { ...meta, manager: true });
        blockTicket(getRun(runId)!, `gate crashed: ${e.message}`);
      });
      return "Submitted to the gate. End your turn now. If the gate fails you will receive findings as your next message.";
    }
    case "factory_verdict": {
      if (r.role !== "reviewer") throw new Error("only reviewers deliver verdicts");
      writeFileSync(join(runDir(r), "verdict.md"), `${args.verdict}\n\n${args.findings}`);
      verdictWaiters.get(runId)?.({ verdict: args.verdict, findings: args.findings });
      return "Verdict recorded. End your turn.";
    }
  }
  throw new Error(`unknown tool ${name}`);
}

export function answerAsk(id: number, answer: string, by: string) {
  const a = db.query("SELECT * FROM asks WHERE id=?").get(id) as any;
  if (!a) throw new Error(`no ask ${id}`);
  db.query("UPDATE asks SET answer=?, answered_by=? WHERE id=?").run(answer, by, id);
  emit(a.ws, "ask.answered", { id, answer, by }, { ticket: a.ticket, run: a.run });
  const waiter = askWaiters.get(id);
  if (waiter) waiter(answer);
  else tellRun(a.run, `Late answer to your ask #${id} ("${a.question}"): ${answer}`);
}

// ------------------------------------------------------------------ gate
async function gate(workerRunId: string, report: string) {
  const r = getRun(workerRunId)!;
  const w = getWs(r.ws)!, s = store.loadSettings(w.path);
  const t = store.getTicket(w.path, r.ticket)!;
  const dir = join(runDir(r), `gate-${r.attempt}`);
  mkdirSync(dir, { recursive: true });
  const meta = { ticket: r.ticket, run: r.id };
  const findings: string[] = [];
  emit(r.ws, "gate.started", { attempt: r.attempt }, meta);

  // 1. structural post-check (works even for harnesses whose guard is weaker)
  // Only committed work is merged, so untracked junk outside scope (harness/tool caches) is ignored on purpose.
  const dirtyTracked = (await git.gitAsync(r.worktree!, "status", "--porcelain", "--untracked-files=no")).out;
  const untrackedInScope = (await git.gitAsync(r.worktree!, "ls-files", "--others", "--exclude-standard")).out.split("\n").filter((f) => f && inScope(f, t.scope_paths));
  if (dirtyTracked) findings.push(`Uncommitted changes to tracked files:\n${dirtyTracked}\nCommit or revert them before submitting.`);
  if (untrackedInScope.length) findings.push(`Untracked files inside scope were never committed: ${untrackedInScope.join(", ")}. Commit or delete them.`);
  const committed = (await git.gitAsync(r.worktree!, "diff", "--name-only", `${s.base_branch}...HEAD`)).out.split("\n").filter(Boolean);
  const outOfScope = committed.filter((f) => !inScope(f, t.scope_paths));
  if ((await git.remoteRefsAsync(w.path)) !== remoteSnap.get(r.id)) findings.push("Remote refs changed during the run — workers must not push.");
  const noCodeExpected = t.tags.some((g) => /^(research|investigation|spike)$/i.test(g)); // a written answer is a valid deliverable
  if (!committed.length && !noCodeExpected) findings.push("No committed changes vs base.");
  const structuralOk = !findings.length;

  // 2. independent verify
  let verifyLog = "";
  const verifyTails: string[] = [];
  for (const [i, cmd] of store.verifyCommands(t).entries()) {
    const res = await sh(cmd, r.worktree!);
    writeFileSync(join(dir, `verify-${i + 1}.log`), `$ ${cmd}\nexit ${res.code}\n\n${res.output}`);
    verifyLog += `- \`${cmd}\` → exit ${res.code}${res.code ? `\n\`\`\`\n${res.output.slice(-3000)}\n\`\`\`` : ""}\n`;
    if (res.code !== 0) {
      const tail = res.output.slice(-3000);
      verifyTails.push(tail);
      findings.push(`Verify failed: \`${cmd}\` exited ${res.code}. Log tail:\n\`\`\`\n${tail}\n\`\`\``);
    }
  }
  emit(r.ws, "gate.verify", { ok: !findings.length, log: verifyLog }, meta);

  // 3. cross-family review (only worth paying for when the cheap checks pass)
  let verdict: { verdict: "PASS" | "FAIL"; findings: string } | null = null;
  if (!findings.length) {
    verdict = await review(r, t, s, report, verifyLog, outOfScope);
    writeFileSync(join(dir, "review.md"), `${verdict.verdict}\n\n${verdict.findings}`);
    if (verdict.verdict !== "PASS") findings.push(`Reviewer findings:\n${verdict.findings}`);
  }

  const gateMd = `### Gate (attempt ${r.attempt})\n- scope/commit/push checks: ${structuralOk ? "ok" : "FAIL"}${outOfScope.length ? `\n- touched outside scope_paths (reviewer judged): ${outOfScope.join(", ")}` : ""}\n- verify:\n${verifyLog || "  (no commands)\n"}- review: ${verdict ? verdict.verdict : "skipped"}\n- evidence: \`${dir}\``;
  if (!findings.length) {
    store.updateTicket(w.path, t.id, { status: "in_review", sections: { Report: `${report}\n\n${gateMd}\n\n${verdict?.findings ?? ""}` } } as any);
    emit(r.ws, "gate.passed", { attempt: r.attempt, head: git.head(r.worktree!) }, { ...meta, manager: true });
    // parked siblings from earlier attempts would otherwise linger on the Workers page forever
    db.query("UPDATE runs SET status='killed', ended_at=? WHERE ws=? AND ticket=? AND role='worker' AND id<>? AND status IN ('idle','paused')").run(Date.now(), r.ws, r.ticket, r.id);
    finishRun(r.id, "done"); // after the emit: finishRun may schedule → plan.drained, which must come last
    return;
  }
  writeFileSync(join(dir, "findings.md"), findings.join("\n\n"));
  // keep the pair's quality record free of failures the ticket's own files cannot explain (infra, flaky timing)
  const atFault = ownFault(t.scope_paths, verifyTails, !structuralOk || verdict?.verdict === "FAIL");
  emit(r.ws, "gate.failed", { attempt: r.attempt, findings, ownFault: atFault }, meta);
  if (r.attempt >= s.max_attempts) {
    store.updateTicket(w.path, t.id, { sections: { Report: `${report}\n\n${gateMd}\n\n#### Unresolved findings\n${findings.join("\n\n")}` } } as any);
    return finishRun(r.id, "failed", `gate failed ${r.attempt}x`);
  }
  updateRun(r.id, { attempt: r.attempt + 1, status: "running", phase: "fix" });
  store.updateTicket(w.path, t.id, { attempts: r.attempt + 1 });
  submitted.delete(r.id);
  nudges.delete(r.id);
  await sendOrResume(r.id, gateFailPrompt(r.attempt, s.max_attempts, findings.join("\n\n")));
}

async function review(worker: Run, t: store.Ticket, s: store.Settings, report: string, verifyLog: string, outOfScope: string[]) {
  const w = getWs(worker.ws)!;
  const { harness, model } = pickReviewer(s, { harness: worker.harness, model: worker.model ?? "" });
  const stat = git.git(worker.worktree!, "diff", "--stat", `${s.base_branch}...HEAD`).out;
  const diff = git.git(worker.worktree!, "diff", `${s.base_branch}...HEAD`).out;
  const id = `r-${Date.now().toString(36)}-rv`;
  db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,phase,worktree,branch,attempt,parent,token,started_at,heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, worker.ws, worker.ticket, "reviewer", harness, model || null, "starting", "review", worker.worktree, worker.branch, worker.attempt, worker.id, crypto.randomUUID(), Date.now(), Date.now());
  const rv = getRun(id)!;
  mkdirSync(runDir(rv), { recursive: true });
  writeFileSync(join(runDir(rv), "decisions.tsv"), "ts\tphase\tdecision\twhy\tevidence\tresult\n");
  emit(worker.ws, "review.started", { harness, model, implementer: worker.harness }, { ticket: worker.ticket, run: id });
  const verdict = new Promise<{ verdict: "PASS" | "FAIL"; findings: string }>((res) => {
    verdictWaiters.set(id, res);
    setTimeout(() => res({ verdict: "FAIL", findings: "Reviewer timed out after 20 minutes." }), 20 * 60e3);
  });
  const body = diff.length > 80000 ? `${stat}\n\n(diff truncated — read files directly)\n${diff.slice(0, 80000)}` : `${stat}\n\n${diff}`;
  await startAdapter(rv, reviewerPrompt(t, store.loadRules(w.path), { diff: body, verifyLog, workerSummary: report, outOfScope, implementer: `${worker.harness}/${worker.model ?? "default"}` }), {});
  const v = await verdict;
  verdictWaiters.delete(id);
  finishRun(id, "done");
  emit(worker.ws, "review.verdict", { verdict: v.verdict, harness }, { ticket: worker.ticket, run: id });
  return v;
}

// ------------------------------------------------------------------ steering
async function sendOrResume(runId: string, text: string) {
  const h = handles.get(runId);
  if (h) return h.send(text, "prompt");
  const r = getRun(runId)!;
  await startAdapter(r, text, { resumeSession: r.session_id, allowedTools: store.loadSettings(getWs(r.ws)!.path).allowed_tools });
}

function tellRun(runId: string, text: string) {
  db.query("INSERT INTO mailbox (run, body, created_at) VALUES (?,?,?)").run(runId, text, Date.now());
}

/** Soft steer: harnesses with live input get it at the next tool boundary; all get it piggybacked on the next factory_* call. */
export function steer(runId: string, text: string) {
  const r = getRun(runId);
  if (!r) throw new Error("unknown run");
  tellRun(runId, text);
  if (r.status !== "gating" && ADAPTERS[r.harness].caps.liveSteer) handles.get(runId)?.send(text, "steer");
  emit(r.ws, "run.steer", { text }, { ticket: r.ticket, run: runId });
}

export async function abortRun(runId: string, text?: string) {
  const r = getRun(runId);
  if (!r) throw new Error("unknown run");
  if (text && ADAPTERS[r.harness].caps.oneProcPerTurn) aborting.add(runId); // only a killed process-per-turn leaks a late turn_end; claude/omp steer in-band
  try {
    await handles.get(runId)?.abort();
    emit(r.ws, "run.abort", { text }, { ticket: r.ticket, run: runId });
    if (text) {
      db.query("UPDATE mailbox SET delivered=1 WHERE run=?").run(runId);
      if (["paused", "idle"].includes(getRun(runId)!.status)) updateRun(runId, { status: "running" }); // a resume turn is starting: no longer parked
      await sendOrResume(runId, `⛔ Interrupted by the manager:\n${text}`);
    } else updateRun(runId, { status: "paused" });
  } finally {
    aborting.delete(runId);
  }
}

export const killRun = (runId: string) => {
  const r = getRun(runId);
  if (r?.role === "worker") store.updateTicket(getWs(r.ws)!.path, r.ticket, { blocked: "killed by manager" });
  finishRun(runId, "killed");
};

/** Manager → ticket: steer the live worker, or resume the last session (blocked / paused / died). */
export async function tell(ws: string, ticketId: string, text: string, o: { abort?: boolean } = {}) {
  const w = mustWs(ws);
  const live = activeWorkerFor(ws, ticketId);
  if (live && live.status !== "idle" && live.status !== "paused") return o.abort ? abortRun(live.id, text) : steer(live.id, text);
  const last = live ?? lastWorkerFor(ws, ticketId);
  store.updateTicket(w.path, ticketId, { blocked: null, status: "in_progress" });
  if (last && live) { updateRun(last.id, { status: "running" }); submitted.delete(last.id); nudges.delete(last.id); return sendOrResume(last.id, text); }
  if (last) return spawnWorker(ws, ticketId, { resumeFrom: last, message: text });
  return spawnWorker(ws, ticketId, {});
}

// ------------------------------------------------------------------ merge (serialized per workspace)
const mergeLocks = new Map<string, Promise<unknown>>();
export function merge(ws: string, ticketId: string) {
  const prev = mergeLocks.get(ws) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => doMerge(ws, ticketId));
  mergeLocks.set(ws, next);
  return next;
}

async function doMerge(ws: string, ticketId: string) {
  const w = mustWs(ws), s = store.loadSettings(w.path);
  const t = store.getTicket(w.path, ticketId);
  if (!t || t.status !== "in_review") throw new Error(`${ticketId} is not in_review`);
  const wt = git.worktreePath(ws, t.id);
  if (!existsSync(wt) || !t.branch) throw new Error(`${ticketId} has no worktree/branch`);
  const meta = { ticket: t.id, manager: true };

  // 1. bring base in (merge, not rebase: the worker can resolve markers with plain add+commit)
  const m = git.git(wt, "merge", "--no-edit", s.base_branch);
  if (!m.ok) {
    const files = git.git(wt, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
    const last = lastWorkerFor(ws, t.id);
    store.updateTicket(w.path, t.id, { status: "in_progress" });
    emit(ws, "merge.conflict", { files }, meta);
    if (last) await spawnWorker(ws, t.id, { resumeFrom: last, message: conflictPrompt(s.base_branch, files) });
    return { status: "conflict", files };
  }
  // 2. re-verify on the merged tree
  for (const cmd of store.verifyCommands(t)) {
    const res = await sh(cmd, wt);
    if (res.code !== 0) {
      const last = lastWorkerFor(ws, t.id);
      store.updateTicket(w.path, t.id, { status: "in_progress" });
      emit(ws, "merge.verify_failed", { cmd, tail: res.output.slice(-2000) }, meta);
      if (last) await spawnWorker(ws, t.id, { resumeFrom: last, message: gateFailPrompt(0, s.max_attempts, `After merging latest ${s.base_branch}, \`${cmd}\` fails:\n\`\`\`\n${res.output.slice(-3000)}\n\`\`\``) });
      return { status: "verify_failed", cmd };
    }
  }
  // 3. land
  const msg = `${t.tags[0] ? `feat(${t.tags[0]})` : "feat"}: ${t.title}\n\nTicket: ${t.id}\n${t.sections.Goal}\n\nFactory-Run: ${lastWorkerFor(ws, t.id)?.id ?? "-"}`;
  let sha: string;
  if (s.merge_via === "pr") {
    const push = git.git(wt, "push", "-u", "origin", t.branch);
    if (!push.ok) throw new Error(`push failed: ${push.err}`);
    const pr = Bun.spawnSync(["gh", "pr", "create", "--base", s.base_branch, "--head", t.branch, "--title", msg.split("\n")[0], "--body", msg], { cwd: wt, windowsHide: true });
    const merged = Bun.spawnSync(["gh", "pr", "merge", t.branch, "--squash", "--delete-branch"], { cwd: wt, windowsHide: true });
    if (merged.exitCode !== 0) throw new Error(`gh pr merge failed: ${merged.stderr.toString()} ${pr.stderr.toString()}`);
    git.git(w.path, "fetch", "origin", git.currentBranch(w.path) === s.base_branch ? s.base_branch : `${s.base_branch}:${s.base_branch}`);
    if (git.currentBranch(w.path) === s.base_branch) git.git(w.path, "merge", "--ff-only", `origin/${s.base_branch}`);
    sha = git.head(w.path, s.base_branch);
  } else {
    sha = git.squashMerge(w.path, t.branch, s.base_branch, msg);
  }
  emit(ws, "merge.landed", { sha }, { ticket: t.id });

  // 4. full-suite verify on base; auto-revert on red
  if (s.verify_cmd) {
    const tmp = git.scratchWorktree(w.path, sha);
    try {
      const res = await sh(s.verify_cmd, tmp, 30 * 60e3);
      if (res.code !== 0) {
        const rev = git.revertOnBase(w.path, s.base_branch, sha, `Auto-revert: \`${s.verify_cmd}\` failed on ${s.base_branch} after merging ${t.id}.`);
        store.updateTicket(w.path, t.id, { status: "open", failed: `reverted: base verify failed (${s.verify_cmd})`, sections: { Report: `${t.sections.Report}\n\n### Auto-revert\n${rev}\n\`\`\`\n${res.output.slice(-3000)}\n\`\`\`` } } as any);
        emit(ws, "merge.reverted", { sha, revert: rev, tail: res.output.slice(-2000) }, meta);
        return { status: "reverted", sha, revert: rev };
      }
    } finally {
      git.removeWorktree(w.path, tmp);
    }
  }
  store.updateTicket(w.path, t.id, { status: "done", blocked: null, failed: null });
  if (t.issue) {
    const issue = store.getIssue(w.path, t.issue);
    const all = store.listTickets(w.path).filter((x) => issue?.tickets.includes(x.id));
    if (issue && all.length && all.every((x) => x.status === "done")) store.updateIssue(w.path, issue.id, { status: "closed", reason: `fixed by ${issue.tickets.join(", ")}` });
  }
  emit(ws, "merge.done", { sha }, meta);
  schedule(ws);
  return { status: "merged", sha };
}

// ------------------------------------------------------------------ gc + doctor
export function gc(ws: string, dry = true) {
  const w = mustWs(ws), s = store.loadSettings(w.path);
  const tickets = new Map(store.listTickets(w.path).map((t) => [t.id, t]));
  const base = join(HOME, "worktrees", ws);
  const actions: { kind: string; target: string; why: string }[] = [];
  for (const id of existsSync(base) ? readdirSync(base) : []) {
    const t = tickets.get(id);
    if (activeWorkerFor(ws, id)) continue;
    if (!t) actions.push({ kind: "worktree", target: join(base, id), why: "ticket no longer exists" });
    else if (t.status === "done") actions.push({ kind: "worktree", target: join(base, id), why: "ticket done (merged)" });
  }
  for (const b of git.git(w.path, "branch", "--format=%(refname:short)", "--list", "factory/*").out.split("\n").filter(Boolean)) {
    const id = b.match(/^factory\/(T-\d+)/)?.[1];
    const t = id ? tickets.get(id) : undefined;
    const merged = git.git(w.path, "merge-base", "--is-ancestor", b, s.base_branch).ok;
    if (t?.status === "done" || merged) actions.push({ kind: "branch", target: b, why: t?.status === "done" ? "ticket done" : `fully merged into ${s.base_branch}` });
  }
  if (!dry) for (const a of actions) a.kind === "worktree" ? git.removeWorktree(w.path, a.target) : git.deleteBranch(w.path, a.target);
  if (!dry) git.git(w.path, "worktree", "prune");
  emit(ws, "gc", { dry, actions });
  return actions;
}

/** Kill every worker/reviewer tree we started. On Windows children inherit the daemon's listening socket, so orphans would keep the port bound. */
export function shutdownAll() {
  for (const [id, h] of handles) { h.kill(); updateRun(id, { status: "idle" }); }
  handles.clear();
}

/** Doctor's cross-family check: with a catalog, the reviewer's `family` must differ from the default worker pair's;
 *  when the catalog is empty, or either pair is missing from it, fall back to the older harness comparison. */
export function reviewerCheck(s: store.Settings): { ok: boolean; detail: string } {
  const worker = { harness: s.default_harness, model: s.harnesses[s.default_harness].model };
  const r = pickReviewer(s, worker);
  const wf = s.catalog[`${worker.harness}:${worker.model}`]?.family;
  const rf = s.catalog[`${r.harness}:${r.model}`]?.family;
  if (Object.keys(s.catalog).length && wf !== undefined && rf !== undefined) return { ok: wf !== rf, detail: `${worker.harness}/${worker.model} → ${r.harness}/${r.model} (${wf} → ${rf})` };
  return { ok: r.harness !== s.default_harness, detail: `${s.default_harness} → ${r.harness}${r.model ? "/" + r.model : ""}` };
}

export function doctor(ws?: string) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  for (const bin of ["git", "claude", "omp", "commandcode", "gh"]) add(`bin:${bin}`, !!Bun.which(bin), Bun.which(bin) ?? "not on PATH");
  const bash = bashPath();
  const bashOk = process.platform === "win32" ? existsSync(bash) : !!Bun.which(bash);
  add("bin:bash", bashOk, bashOk ? bash : `${bash} not found (PATH bash: ${Bun.which("bash") ?? "none"})`);
  const orphans = db.query("SELECT * FROM runs WHERE status IN ('starting','running','gating') ").all() as Run[];
  for (const r of orphans) if (!handles.has(r.id)) add(`orphan run ${r.id}`, false, `${r.ticket} ${r.status} but no live process — \`factory tell ${r.ticket}\` to resume`);
  for (const w of ws ? [mustWs(ws)] : listWorkspaces()) {
    const s = store.loadSettings(w.path);
    add(`${w.id}: repo`, existsSync(w.path) && !!git.repoRoot(w.path), w.path);
    add(`${w.id}: base ${s.base_branch}`, git.git(w.path, "rev-parse", "--verify", s.base_branch).ok);
    add(`${w.id}: rules.md scanned`, !/run \/factory:init/.test(store.loadRules(w.path)), "standing orders");
    add(`${w.id}: verify recipe`, existsSync(join(w.path, ".factory", "verify.md")), ".factory/verify.md");
    for (const [h, c] of Object.entries(s.harnesses)) if (c.enabled) add(`${w.id}: harness ${h}`, !!Bun.which(h), c.model || "default model");
    const n = Object.keys(s.catalog).length;
    add(`${w.id}: model catalog`, true, n ? `${(s as any)[store.CATALOG_FROM_GLOBAL] ? "global" : "repo"} (${n} entries)` : "none — routing uses default_harness");
    const rc = reviewerCheck(s);
    add(`${w.id}: cross-family reviewer`, rc.ok, rc.detail);
    const invalid = store.listTickets(w.path).filter((t) => t.status === "open" && store.validateBrief(t).length);
    add(`${w.id}: open tickets have valid briefs`, !invalid.length, invalid.map((t) => t.id).join(", "));
  }
  return checks;
}

// stuck detection: no heartbeat for 15 min while running
setInterval(() => {
  const stale = db.query("SELECT * FROM runs WHERE status='running' AND heartbeat_at < ?").all(Date.now() - 15 * 60e3) as Run[];
  for (const r of stale) {
    emit(r.ws, "run.stuck", { minutes: Math.round((Date.now() - (r.heartbeat_at ?? r.started_at)) / 60e3) }, { ticket: r.ticket, run: r.id, manager: true });
    updateRun(r.id, { heartbeat_at: Date.now() }); // re-alert in another 15 min, not every tick
  }
}, 60e3);

/** On daemon start, runs whose process died with the old daemon are marked idle so the manager can resume them. */
export function recoverAfterRestart() {
  const dead = db.query("SELECT * FROM runs WHERE status IN ('starting','running','gating')").all() as Run[];
  for (const r of dead) {
    killTree(r.pid);
    updateRun(r.id, { status: r.role === "worker" ? "idle" : "failed", ended_at: r.role === "worker" ? null : Date.now() });
    if (r.role === "worker") {
      const w = getWs(r.ws);
      if (w) store.updateTicket(w.path, r.ticket, { blocked: "daemon restarted mid-run — `factory tell` to resume" });
      emit(r.ws, "run.died", { reason: "daemon restart" }, { ticket: r.ticket, run: r.id, manager: true });
    }
  }
}
