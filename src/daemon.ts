import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, emit, getRun, HOME, onEvent, PORT, type Run } from "./db";
import { pickFolder } from "./folder-pick";
import * as git from "./git";
import * as herdr from "./herdr";
import { handleMcp } from "./mcp";
import { listModels } from "./models";
import { ROOT } from "./prompts";
import * as store from "./store";
import * as sup from "./supervisor";

const json = (d: unknown, status = 200) => Response.json(d, { status });
const body = async (req: Request) => (req.headers.get("content-length") === "0" ? {} : req.json().catch(() => ({})));
const wsPath = (id: string) => sup.mustWs(id).path;
/** Ticket status → count for the console; a workspace whose repo is gone lists no tickets, so it yields {}. */
const ticketCounts = (repo: string) =>
  store.listTickets(repo).reduce<Record<string, number>>((acc, t) => ((acc[t.status] = (acc[t.status] ?? 0) + 1), acc), {});

/** The workspace's manager pane in herdr. Found by session id first; `/clear` gives the pane a new session id, so the herdr name
 *  (set when we start or first see the pane) re-links it and the workspace follows to the new session. */
async function managerAgent(w: ReturnType<typeof sup.mustWs>) {
  const name = herdr.agentName(w.id);
  // no .catch: a herdr failure must throw (unavailable), never read as "no agent" (absent) — null below means the list worked and found nothing
  let a = w.manager ? await herdr.findAgent(w.manager) : null;
  if (a) { if (a.name !== name) herdr.nameAgent(a.pane_id, name).catch(() => {}); return a; }
  a = await herdr.findByName(name);
  const sid = a?.agent_session?.value;
  if (a && sid && sid !== w.manager) sup.attachManager(w.id, sid, true);
  return a;
}

function runDetail(r: Run) {
  const dir = join(HOME, "runs", r.ws, r.ticket, r.id);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const tail = read("transcript.jsonl").split("\n").slice(-300).join("\n");
  const evidence = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()) : [];
  return { ...r, token: undefined, dir, decisions: read("decisions.tsv"), report: read("report.md"), transcript_tail: tail, evidence };
}

// A second interrupt while Claude is still reacting to the first opens the Rewind menu and eats the next prompt, so ignore repeats on the same pane for a beat.
const lastInterrupt = new Map<string, number>();

// ---- file watcher: humans and the manager edit .factory/*.md directly
const watchers = new Map<string, ReturnType<typeof watch>>();
function watchWs(id: string, path: string) {
  if (watchers.has(id) || !existsSync(join(path, ".factory"))) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  watchers.set(id, watch(join(path, ".factory"), { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => { if (watchers.has(id)) emit(id, "store.changed", {}); }, 250); // a removed workspace's debounce must not fire
  }));
}
type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
const wrap = (h: Handler) => async (req: any) => {
  try { return await h(req); } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); }
};
const routes: Record<string, Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>> = {
  "/health": { GET: () => json({ ok: true, pid: process.pid, root: ROOT }) },
  "/api/shutdown": { POST: () => { sup.shutdownAll(); setTimeout(() => process.exit(0), 300); return json({ ok: true }); } },

  "/api/workspaces": {
    GET: async () => {
      let agents: herdr.HerdrAgent[] = [];
      try { agents = await herdr.listAgents(); } catch { /* herdr unavailable: keep every workspace manager status null */ }
      return json(sup.listWorkspaces().map((w) => {
        const name = herdr.agentName(w.id);
        const agent = agents.find((a) => a.agent === "claude" && w.manager && a.agent_session?.value === w.manager)
          ?? agents.find((a) => a.agent === "claude" && a.name === name);
        return { ...w, manager_status: agent?.agent_status ?? null, settings: store.loadSettings(w.path), plan: sup.planState(w.id), counts: ticketCounts(w.path) };
      }));
    },
    POST: async (req) => { const { path } = await body(req); const w = sup.registerWorkspace(path); watchWs(w.id, w.path); return json(w); },
  },
  "/api/workspaces/:id": {
    DELETE: ({ params }) => {
      const w = sup.removeWorkspace(params.id);
      watchers.get(w.id)?.close();
      watchers.delete(w.id);
      return json({ ok: true, id: w.id });
    },
  },
  /** Browsers can't hand back an absolute path, so the daemon opens the OS folder dialog on its own machine. */
  "/api/fs/pick-folder": { POST: async () => json({ path: await pickFolder() }) },
  "/api/ws/:ws": {
    GET: ({ params }) => { const w = sup.mustWs(params.ws); return json({ ...w, settings: store.loadSettings(w.path), rules: store.loadRules(w.path), plan: sup.planState(w.id) }); },
  },
  "/api/ws/:ws/attach": { POST: async (req) => { const b = await body(req); sup.attachManager(req.params.ws, b.session, b.force); return json({ ok: true }); } },
  // chat = the manager's Claude session inside herdr: transcript for reading, `herdr agent prompt` for writing
  "/api/ws/:ws/chat": {
    GET: async (req) => {
      const w = sup.mustWs(req.params.ws);
      let agent: herdr.HerdrAgent | null = null;
      try { agent = await managerAgent(w); } catch (e) { return json({ error: `herdr unavailable: ${e instanceof Error ? e.message : String(e)}` }, 503); } // wrap's 400 would read as "offline"; the UI poll surfaces repeated 503s
      const fresh = sup.mustWs(req.params.ws); // re-read: a /clear re-links the workspace to the pane's new session
      const requested = Number(new URL(req.url).searchParams.get("limit") ?? 300);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(2000, Math.floor(requested))) : 300;
      if (!fresh.manager) return json({ rev: JSON.stringify(["", limit, 0]), session: null, status: "none", suggestion: null, total: 0, messages: [] });
      const { rev: transcriptRev, msgs, total, model, activity, queued } = herdr.readChat(fresh.manager, limit);
      const ansiScreen = agent ? await herdr.readAnsiScreen(agent.pane_id) : "";
      const screen = ansiScreen.replace(/\x1b\[[0-9;]*m/g, "");
      const usage = agent ? herdr.usageFrom(screen) : null;
      const prompt = agent ? await herdr.promptFrom(agent.pane_id, screen, agent.agent_status === "blocked", ansiScreen) : null;
      const suggestion = agent && ["idle", "done"].includes(agent.agent_status) ? herdr.suggestionFrom(ansiScreen) : null;
      // no pane: nothing will ever deliver the task notifications, so a "background" tool is dead — clear it on copies (readChat caches these objects)
      const live = !!agent;
      const messages = live ? msgs : msgs.map((m) => (m.tool?.status === "background" ? { ...m, tool: { ...m.tool, status: "done" } } : m));
      const status = agent?.agent_status ?? "offline", pane = agent?.pane_id ?? null;
      const rev = JSON.stringify([transcriptRev, fresh.manager, pane, status, prompt, suggestion, queued, usage, model, live ? activity : { ...activity, background: 0 }, limit, total]);
      return json({ rev, session: fresh.manager, pane, status, model, usage, prompt, suggestion, total,
        activity: live ? activity : { ...activity, background: 0 }, queued, messages });
    },
    POST: async (req) => {
      const w = sup.mustWs(req.params.ws), agent = await managerAgent(w);
      if (!agent) throw new Error("manager session is not running in herdr — start or resume one");
      const b = await body(req);
      if (agent.agent_status === "blocked") throw new Error("manager is waiting for an answer; use /chat/answer");
      const ansiScreen = await herdr.readAnsiScreen(agent.pane_id);
      const screen = ansiScreen.replace(/\x1b\[[0-9;]*m/g, "");
      if (await herdr.promptFrom(agent.pane_id, screen, false, ansiScreen)) throw new Error("manager is waiting for an answer; use /chat/answer");
      if (b.interrupt && agent.agent_status === "working") {
        await herdr.interrupt(agent.pane_id);
        await Bun.sleep(450);
        const fresh = await managerAgent(w);
        if (!fresh || fresh.agent_status === "blocked") throw new Error("manager is waiting for an answer; use /chat/answer");
        const freshAnsi = await herdr.readAnsiScreen(fresh.pane_id);
        const freshScreen = freshAnsi.replace(/\x1b\[[0-9;]*m/g, "");
        if (await herdr.promptFrom(fresh.pane_id, freshScreen, false, freshAnsi)) throw new Error("manager is waiting for an answer; use /chat/answer");
        await herdr.prompt(fresh.pane_id, b.text, true);
      } else await herdr.prompt(agent.pane_id, b.text, true);
      herdr.noteSent(b.text); // /reload-plugins re-reads the plugin dirs, so the autocomplete must rescan instead of serving the 30s cache
      return json({ ok: true });
    },
  },
  /** Images for the chat: saved under FACTORY_HOME/uploads/<ws>; the message then carries an `@path` mention, which Claude Code turns into an image attachment. */
  "/api/ws/:ws/chat/upload": {
    POST: async (req) => {
      const w = sup.mustWs(req.params.ws), b = await body(req);
      const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[String(b.mime)];
      if (!ext) throw new Error("only png, jpeg, gif or webp images");
      const bytes = Buffer.from(String(b.data ?? ""), "base64");
      if (!bytes.length || bytes.length > 15e6) throw new Error("image must be between 1 byte and 15 MB");
      const dir = join(HOME, "uploads", w.id);
      mkdirSync(dir, { recursive: true });
      const file = `${Date.now().toString(36)}-${basename(String(b.name ?? "image")).replace(/[^\w.-]+/g, "_").replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "image"}.${ext}`;
      writeFileSync(join(dir, file), bytes);
      return json({ path: join(dir, file).replace(/\\/g, "/"), url: `/api/uploads/${w.id}/${file}` });
    },
  },
  "/api/uploads/:ws/:file": {
    GET: ({ params }) => {
      const p = join(HOME, "uploads", basename(params.ws), basename(params.file));
      return existsSync(p) ? new Response(Bun.file(p), { headers: { "cache-control": "private, max-age=86400" } }) : json({ error: "not found" }, 404);
    },
  },
  "/api/ws/:ws/chat/commands": { GET: ({ params }) => json(herdr.slashCommands(wsPath(params.ws))) },
  /** Answer whatever the session is waiting on: { keys?, text?, enter? } — see herdr.answer. */
  "/api/ws/:ws/chat/answer": {
    POST: async (req) => {
      const w = sup.mustWs(req.params.ws), agent = await managerAgent(w);
      if (!agent) throw new Error("manager session is not running in herdr");
      await herdr.answer(agent.pane_id, await body(req));
      return json({ ok: true });
    },
  },
  "/api/ws/:ws/chat/interrupt": {
    POST: async ({ params }) => {
      const w = sup.mustWs(params.ws), agent = await managerAgent(w);
      // Esc on an idle Claude opens the Rewind menu and silently swallows the next prompt, so only send it while it is actually working.
      if (!agent || agent.agent_status !== "working") return json({ ok: true, skipped: true });
      const now = Date.now(), last = lastInterrupt.get(agent.pane_id) ?? 0;
      if (now - last < 1000) return json({ ok: true, skipped: true }); // set before the await so concurrent clicks can't both pass
      for (const [pane, at] of lastInterrupt) if (now - at > 10_000) lastInterrupt.delete(pane);
      lastInterrupt.set(agent.pane_id, now);
      await herdr.interrupt(agent.pane_id);
      return json({ ok: true });
    },
  },
  /** { resume: true } continues the attached session; otherwise a fresh claude session starts in a new herdr workspace. */
  "/api/ws/:ws/chat/start": {
    POST: async (req) => {
      const w = sup.mustWs(req.params.ws), b = await body(req);
      const old = await managerAgent(w); // retire the previous manager pane: it would otherwise linger in herdr and keep the factory-<ws> name
      if (old) {
        if (old.agent_status === "working") throw new Error("the current manager session is still working — interrupt it first");
        await herdr.closePane(old.pane_id);
        await Bun.sleep(500);
      }
      const session = await herdr.startClaude(w.path, w.name, herdr.agentName(w.id), b.resume ? w.manager ?? undefined : undefined, herdr.managerBrief(w));
      sup.attachManager(w.id, session, true);
      return json({ session });
    },
  },
  "/api/ws/:ws/settings": {
    GET: ({ params }) => json(store.loadSettings(wsPath(params.ws))),
    PUT: async (req) => { const p = wsPath(req.params.ws); store.saveSettings(p, { ...store.loadSettings(p), ...(await body(req)) }); emit(req.params.ws, "settings.changed"); return json(store.loadSettings(p)); },
  },
  "/api/ws/:ws/rules": {
    GET: ({ params }) => new Response(store.loadRules(wsPath(params.ws))),
    PUT: async (req) => { store.saveRules(wsPath(req.params.ws), await req.text()); emit(req.params.ws, "rules.changed"); return json({ ok: true }); },
  },

  "/api/ws/:ws/tickets": {
    GET: ({ params }) => {
      const last = new Map((db.query("SELECT ticket, harness, model FROM runs WHERE ws=? AND role='worker' ORDER BY started_at, rowid").all(params.ws) as { ticket: string; harness: string; model: string | null }[]).map((r) => [r.ticket, { harness: r.harness, model: r.model }]));
      return json(store.listTickets(wsPath(params.ws)).map((t) => ({ ...t, brief_errors: store.validateBrief(t), run: last.get(t.id) ?? null })));
    },
    POST: async (req) => { const t = store.createTicket(wsPath(req.params.ws), await body(req)); emit(req.params.ws, "ticket.created", { id: t.id }, { ticket: t.id }); return json({ ...t, brief_errors: store.validateBrief(t) }); },
  },
  "/api/ws/:ws/tickets/:id": {
    GET: ({ params }) => {
      const p = wsPath(params.ws), t = store.getTicket(p, params.id);
      if (!t) return json({ error: "not found" }, 404);
      const runs = db.query("SELECT * FROM runs WHERE ws=? AND ticket=? ORDER BY started_at DESC, rowid DESC").all(params.ws, params.id) as Run[];
      const w = runs.find((r) => r.role === "worker"); // runs are newest-first
      return json({ ...t, brief_errors: store.validateBrief(t), run: w ? { harness: w.harness, model: w.model } : null, runs: runs.map((r) => ({ ...r, token: undefined })) });
    },
    PATCH: async (req) => {
      const p = wsPath(req.params.ws), patch = await body(req), cur = store.getTicket(p, req.params.id);
      if (!cur) return json({ error: "not found" }, 404);
      if (patch.status === "open" && cur.status === "draft") {
        const errs = store.validateBrief({ ...cur, ...patch, sections: { ...cur.sections, ...patch.sections } });
        if (errs.length) return json({ error: "brief incomplete", brief_errors: errs }, 422);
      }
      const t = store.updateTicket(p, req.params.id, patch);
      emit(req.params.ws, "ticket.updated", { id: t.id, status: t.status }, { ticket: t.id });
      if (patch.status === "open") sup.schedule(req.params.ws);
      return json(t);
    },
  },
  "/api/ws/:ws/tickets/:id/diff": {
    GET: ({ params }) => {
      const w = sup.mustWs(params.ws), s = store.loadSettings(w.path);
      const wt = git.worktreePath(w.id, params.id);
      if (!existsSync(wt)) return new Response("");
      return new Response(git.git(wt, "diff", `${s.base_branch}...HEAD`).out);
    },
  },
  "/api/ws/:ws/tickets/:id/merge": { POST: async ({ params }) => json(await sup.merge(params.ws, params.id)) },
  "/api/ws/:ws/tickets/:id/tell": { POST: async (req) => { const b = await body(req); await sup.tell(req.params.ws, req.params.id, b.text, { abort: b.abort }); return json({ ok: true }); } },
  "/api/ws/:ws/tickets/:id/spawn": { POST: async (req) => json(await sup.spawnWorker(req.params.ws, req.params.id, await body(req))) },

  "/api/ws/:ws/issues": {
    GET: ({ params }) => json(store.listIssues(wsPath(params.ws))),
    POST: async (req) => { const i = store.createIssue(wsPath(req.params.ws), await body(req)); emit(req.params.ws, "issue.created", { id: i.id }); return json(i); },
  },
  "/api/ws/:ws/issues/:id": {
    PATCH: async (req) => { const i = store.updateIssue(wsPath(req.params.ws), req.params.id, await body(req)); emit(req.params.ws, "issue.updated", { id: i.id }); return json(i); },
  },

  "/api/ws/:ws/runs": {
    GET: ({ params }) => json((db.query("SELECT * FROM runs WHERE ws=? ORDER BY started_at DESC LIMIT 200").all(params.ws) as Run[]).map((r) => ({ ...r, token: undefined }))),
  },
  "/api/runs/:id": { GET: ({ params }) => { const r = getRun(params.id); return r ? json(runDetail(r)) : json({ error: "not found" }, 404); } },
  "/api/runs/:id/steer": { POST: async (req) => { sup.steer(req.params.id, (await body(req)).text); return json({ ok: true }); } },
  "/api/runs/:id/abort": { POST: async (req) => { await sup.abortRun(req.params.id, (await body(req)).text); return json({ ok: true }); } },
  "/api/runs/:id/kill": { POST: ({ params }) => { sup.killRun(params.id); return json({ ok: true }); } },
  "/api/runs/:id/file": {
    GET: (req) => {
      const r = getRun(req.params.id)!, f = new URL(req.url).searchParams.get("f") ?? "";
      const dir = join(HOME, "runs", r.ws, r.ticket, r.id), p = join(dir, f);
      return p.startsWith(dir) && existsSync(p) ? new Response(Bun.file(p)) : json({ error: "not found" }, 404);
    },
  },
  // omp extension bridge + guard reports (token-authenticated like MCP)
  "/api/runs/:id/tool/:name": {
    POST: async (req) => {
      const r = getRun(req.params.id);
      if (!r || req.headers.get("x-factory-token") !== r.token) return json({ error: "unauthorized" }, 401);
      return json({ text: await sup.callTool(r.id, req.params.name, await body(req)) });
    },
  },
  "/api/runs/:id/guard": {
    POST: async (req) => {
      const r = getRun(req.params.id);
      if (!r || req.headers.get("x-factory-token") !== r.token) return json({ error: "unauthorized" }, 401);
      emit(r.ws, "guard.blocked", await body(req), { ticket: r.ticket, run: r.id });
      return json({ ok: true });
    },
  },

  "/api/ws/:ws/asks": { GET: ({ params }) => json(db.query("SELECT * FROM asks WHERE ws=? ORDER BY id DESC LIMIT 100").all(params.ws)) },
  "/api/asks/:id/answer": { POST: async (req) => { const b = await body(req); sup.answerAsk(Number(req.params.id), b.answer, b.by ?? "human"); return json({ ok: true }); } },

  "/api/ws/:ws/run": { POST: async (req) => json(sup.startPlan(req.params.ws, await body(req))) },
  "/api/ws/:ws/stop": { POST: ({ params }) => { sup.stopPlan(params.ws); return json({ ok: true }); } },
  "/api/ws/:ws/gc": { POST: async (req) => json(sup.gc(req.params.ws, (await body(req)).dry !== false)) },
  "/api/models": { GET: async (req) => json(await listModels(new URL(req.url).searchParams.has("refresh"))) },
  "/api/doctor": { GET: (req) => json(sup.doctor(new URL(req.url).searchParams.get("ws") ?? undefined)) },

  "/api/ws/:ws/events": {
    GET: (req) => {
      const u = new URL(req.url);
      const rows = db.query("SELECT * FROM events WHERE ws=? AND id>? ORDER BY id DESC LIMIT ?").all(req.params.ws, Number(u.searchParams.get("since") ?? 0), Number(u.searchParams.get("limit") ?? 300)) as any[];
      return json(rows.reverse().map((e) => ({ ...e, data: JSON.parse(e.data ?? "{}") })));
    },
  },
  /** Manager long-poll: returns as soon as a manager-relevant event exists after `since`. */
  "/api/ws/:ws/wait": {
    GET: async (req) => {
      const u = new URL(req.url), ws = req.params.ws, since = Number(u.searchParams.get("since") ?? 0);
      const timeout = Math.min(Number(u.searchParams.get("timeout") ?? 600), 3000) * 1000;
      sup.touchManager(ws);
      const q = () => (db.query("SELECT * FROM events WHERE ws=? AND id>? AND for_manager=1 ORDER BY id").all(ws, since) as any[]).map((e) => ({ ...e, data: JSON.parse(e.data ?? "{}") }));
      let rows = q();
      if (!rows.length) {
        await new Promise<void>((res) => {
          const off = onEvent((e) => { if (e.ws === ws && e.for_manager) { off(); setTimeout(res, 1500); } }); // small window to batch siblings
          setTimeout(() => { off(); res(); }, timeout);
        });
        rows = q();
      }
      sup.touchManager(ws);
      return json({ events: rows, cursor: rows.at(-1)?.id ?? since });
    },
  },
};

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  routes: Object.fromEntries(Object.entries(routes).map(([path, methods]) => [path, Object.fromEntries(Object.entries(methods).map(([m, h]) => [m, wrap(h!)]))])),
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/live") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    const mcp = url.pathname.match(/^\/mcp\/([\w-]+)$/);
    if (mcp) {
      const r = getRun(mcp[1]);
      if (!r || url.searchParams.get("t") !== r.token) return json({ error: "unauthorized" }, 401);
      return handleMcp(req, r.role, (name, args) => sup.callTool(r.id, name, args));
    }
    // MCP clients probe OAuth discovery; an HTML 200 here makes them hang, so non-page paths must 404.
    if (/^\/(\.well-known|api|mcp)\b/.test(url.pathname)) return json({ error: "not found" }, 404);
    const dist = join(ROOT, "ui", "dist");
    const file = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    if (existsSync(join(dist, "index.html"))) return new Response(Bun.file(join(dist, "index.html")));
    return new Response("UI not built — run `bun run build`", { status: 404 });
  },
  websocket: {
    open(ws) { ws.subscribe("events"); },
    message() {},
  },
});
for (const w of sup.listWorkspaces()) {
  try { store.ensureLayout(w.path); } catch { /* A broken repo layout must not prevent daemon startup. */ }
  watchWs(w.id, w.path);
}
sup.recoverAfterRestart();
onEvent((e) => server.publish("events", JSON.stringify(e)));
console.log(`factoryd listening on http://127.0.0.1:${PORT} (home ${HOME}, pid ${process.pid})`);

