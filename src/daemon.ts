import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { db, emit, getRun, HOME, onEvent, PORT, type Run } from "./db";
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

/** The workspace's manager pane in herdr. Found by session id first; `/clear` gives the pane a new session id, so the herdr name
 *  (set when we start or first see the pane) re-links it and the workspace follows to the new session. */
async function managerAgent(w: ReturnType<typeof sup.mustWs>) {
  const name = herdr.agentName(w.id);
  let a = w.manager ? await herdr.findAgent(w.manager).catch(() => null) : null;
  if (a) { if (a.name !== name) herdr.nameAgent(a.pane_id, name).catch(() => {}); return a; }
  a = await herdr.findByName(name).catch(() => null);
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

// ---- file watcher: humans and the manager edit .factory/*.md directly
const watchers = new Map<string, ReturnType<typeof watch>>();
function watchWs(id: string, path: string) {
  if (watchers.has(id) || !existsSync(join(path, ".factory"))) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  watchers.set(id, watch(join(path, ".factory"), { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => emit(id, "store.changed", {}), 250);
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
    GET: () => json(sup.listWorkspaces().map((w) => ({ ...w, settings: store.loadSettings(w.path), plan: sup.planState(w.id) }))),
    POST: async (req) => { const { path } = await body(req); const w = sup.registerWorkspace(path); watchWs(w.id, w.path); return json(w); },
  },
  "/api/ws/:ws": {
    GET: ({ params }) => { const w = sup.mustWs(params.ws); return json({ ...w, settings: store.loadSettings(w.path), rules: store.loadRules(w.path), plan: sup.planState(w.id) }); },
  },
  "/api/ws/:ws/attach": { POST: async (req) => { const b = await body(req); sup.attachManager(req.params.ws, b.session, b.force); return json({ ok: true }); } },
  // chat = the manager's Claude session inside herdr: transcript for reading, `herdr agent prompt` for writing
  "/api/ws/:ws/chat": {
    GET: async ({ params }) => {
      const agent = await managerAgent(sup.mustWs(params.ws));
      const w = sup.mustWs(params.ws); // re-read: a /clear re-links the workspace to the pane's new session
      if (!w.manager) return json({ session: null, status: "none", messages: [] });
      const { msgs, model, activity } = herdr.readChat(w.manager);
      const screen = agent ? await herdr.readScreen(agent.pane_id) : "";
      const usage = agent ? herdr.usageFrom(screen) : null;
      const prompt = agent ? await herdr.promptFrom(agent.pane_id, screen, agent.agent_status === "blocked") : null;
      return json({ session: w.manager, pane: agent?.pane_id ?? null, status: agent?.agent_status ?? "offline", model, usage, prompt, activity, messages: msgs });
    },
    POST: async (req) => {
      const w = sup.mustWs(req.params.ws), agent = await managerAgent(w);
      if (!agent) throw new Error("manager session is not running in herdr — start or resume one");
      await herdr.prompt(agent.pane_id, (await body(req)).text);
      return json({ ok: true });
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
      if (agent) await herdr.interrupt(agent.pane_id);
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
      const session = await herdr.startClaude(w.path, w.name, herdr.agentName(w.id), b.resume ? w.manager ?? undefined : undefined);
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
    GET: ({ params }) => json(store.listTickets(wsPath(params.ws)).map((t) => ({ ...t, brief_errors: store.validateBrief(t) }))),
    POST: async (req) => { const t = store.createTicket(wsPath(req.params.ws), await body(req)); emit(req.params.ws, "ticket.created", { id: t.id }, { ticket: t.id }); return json(t); },
  },
  "/api/ws/:ws/tickets/:id": {
    GET: ({ params }) => {
      const p = wsPath(params.ws), t = store.getTicket(p, params.id);
      if (!t) return json({ error: "not found" }, 404);
      const runs = db.query("SELECT * FROM runs WHERE ws=? AND ticket=? ORDER BY started_at DESC").all(params.ws, params.id) as Run[];
      return json({ ...t, brief_errors: store.validateBrief(t), runs: runs.map((r) => ({ ...r, token: undefined })) });
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
  "/api/runs/:id/scope": {
    GET: (req) => {
      const r = getRun(req.params.id);
      if (!r || req.headers.get("x-factory-token") !== r.token) return json({ error: "unauthorized" }, 401);
      return json({ scope: store.getTicket(sup.mustWs(r.ws).path, r.ticket)?.scope_paths ?? [] });
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
for (const w of sup.listWorkspaces()) watchWs(w.id, w.path);
sup.recoverAfterRestart();
onEvent((e) => server.publish("events", JSON.stringify(e)));
console.log(`factoryd listening on http://127.0.0.1:${PORT} (home ${HOME}, pid ${process.pid})`);

