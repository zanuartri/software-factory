import { ArrowDown, ArrowUp, Maximize2, Minimize2, PanelLeftClose, Paperclip, Play, Plus, RotateCw, Square, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Workspace } from "./api";
import { AnswerLog, AskCard, type Answer, type Prompt } from "./ask";
import { AgentCard, NoticeRow, TodoCard, ToolRow, UserBubble, type Activity, type Msg } from "./thread";
import { Select } from "./select";
import { firstLoadOutcome } from "./chat-load";
import { Btn, Dot, Md } from "./ui";
import { reconcilePending, type PendingMessage } from "./chat-state";

type Chat = { rev: string; session: string | null; pane?: string | null; status: string; model?: string | null; activity?: Activity; queued?: string[]; prompt?: Prompt | { raw: string } | null; suggestion?: string | null; usage?: { ctx: (Meter & { used: string; size: string }) | null; h5: Meter | null; d7: Meter | null } | null; messages: Msg[]; total: number };
type Cmd = { name: string; desc: string };
type Pending = PendingMessage & { imgs: string[] };
const promptSignature = (prompt: Prompt | { raw: string }) => "raw" in prompt ? prompt.raw : JSON.stringify([prompt.title, prompt.tabs.map((tab) => tab.label)]);

const MessageRow = memo(function MessageRow({ m, latestTodo }: { m: Msg; latestTodo: boolean }) {
  if (m.role === "user" && !m.qa) return <UserBubble text={m.text} images={m.images} />;
  if (m.qa) return <AnswerLog qa={m.qa} skipped={m.skipped} />;
  if (m.notice) return <NoticeRow n={m.notice} />;
  if (m.tool?.agent) return <AgentCard t={m.tool} />;
  if (m.tool?.todos) return <TodoCard t={m.tool} latest={latestTodo} />;
  if (m.tool) return <ToolRow t={m.tool} />;
  if (m.role === "user") return <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] text-on-bubble">{m.text}</div>;
  return <Md text={m.text} className="break-words" copyCode />;
});

const ChatThread = memo(function ChatThread({ chat, pending, st, live, busy, wide, lastTodo, activity, start, answer, stick, limit, loadEarlier, loadingEarlier, loadError, retry }: {
  chat: Chat | null; pending: Pending[]; st: string; live: boolean; busy: boolean; wide: string; lastTodo?: string;
  activity?: Activity; start: (resume: boolean) => void; answer: (a: Answer) => void; stick: { current: boolean };
  limit: number; loadEarlier: () => void; loadingEarlier: boolean; loadError: string | null; retry: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const msgs = chat?.messages ?? [];
  const restoreScroll = useRef<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current, restore = restoreScroll.current;
    if (el && restore) { el.scrollTop = restore.top + el.scrollHeight - restore.height; restoreScroll.current = null; }
  }, [chat?.messages.length]);
  useEffect(() => {
    const el = scroller.current, body = content.current;
    if (!el || !body) return;
    const update = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      else setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    };
    const observer = new ResizeObserver(update);
    observer.observe(body); observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [stick]);
  const [openToolRuns, setOpenToolRuns] = useState<Set<string>>(() => new Set());
  const copy = useCallback(async (text: string) => {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
    const area = document.createElement("textarea");
    area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select();
    const ok = document.execCommand("copy"); area.remove();
    return ok;
  }, []);
  const onCopyCode = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("[data-copy-code]");
    if (!button || !e.currentTarget.contains(button)) return;
    const code = button.closest("[data-code-block]")?.querySelector("code")?.textContent ?? "";
    void copy(code).then((ok) => {
      if (!ok) return;
      button.dataset.copied = "true"; button.textContent = "Copied";
      window.setTimeout(() => { button.dataset.copied = ""; button.textContent = "Copy"; }, 1500);
    });
  }, [copy]);
  const toggleToolRun = useCallback((id: string) => setOpenToolRuns((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const timeLabel = (ts: number) => {
    const date = new Date(ts), today = new Date();
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const days = Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000);
    return days > 0 ? `${days === 1 ? "yesterday" : date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}` : time;
  };
  const copyMessage = useCallback((button: HTMLButtonElement, text: string) => {
    void copy(text).then((ok) => {
      if (!ok) return;
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = "Copy"; }, 1500);
    });
  }, [copy]);
  const rows: (Msg | { id: string; run: Msg[] })[] = [];
  for (let i = 0; i < msgs.length;) {
    if (msgs[i].tool) {
      let end = i + 1;
      while (end < msgs.length && msgs[end].tool) end++;
      if (end - i >= 3) { rows.push({ id: msgs[i].id, run: msgs.slice(i, end) }); i = end; continue; }
    }
    rows.push(msgs[i]); i++;
  }
  let priorTs: number | undefined;
  const renderedRows = rows.map((row) => {
    if ("run" in row) {
      const run = row.run, open = openToolRuns.has(row.id), firstTs = run.find((m) => m.ts !== undefined)?.ts, runTs = run.at(-1)?.ts ?? firstTs;
      const separator = firstTs !== undefined && priorTs !== undefined && firstTs - priorTs > 30 * 60 * 1000;
      if (runTs !== undefined) priorTs = runTs;
      const separatorLabel = firstTs === undefined ? null : timeLabel(firstTs);
      const label = runTs === undefined ? null : timeLabel(runTs);
      const flagged = run.some((m) => m.tool?.status === "running" || m.tool?.status === "background" || m.tool?.status === "error");
      return <div key={row.id}>
        {separator && <div className="py-1 text-center text-[10.5px] text-fg-subtle">{separatorLabel}</div>}
        <div className={`group relative ${flagged ? "rounded-md border border-warning/40 bg-warning/5 px-2" : ""}`}>
          <button type="button" aria-expanded={open} onClick={() => toggleToolRun(row.id)} className="flex w-full items-center gap-1.5 py-1 text-left text-[11.5px] font-medium text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
            <span aria-hidden className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>{run.length} tool calls
            {flagged && <span className="text-warning">· active or failed</span>}
            {label && <time dateTime={new Date(runTs!).toISOString()} className="ml-auto text-[10px] font-normal text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{label}</time>}
          </button>
          {open && <div className="space-y-2">{run.map((m) => <div key={m.id} className="group relative">
            <MessageRow m={m} latestTodo={m.id === lastTodo} />
            {m.ts !== undefined && <time dateTime={new Date(m.ts).toISOString()} className="pointer-events-none absolute -top-3 right-1 text-[10px] text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100">{timeLabel(m.ts)}</time>}
          </div>)}</div>}
        </div>
      </div>;
    }
    const m = row;
    const separator = m.ts !== undefined && priorTs !== undefined && m.ts - priorTs > 30 * 60 * 1000;
    if (m.ts !== undefined) priorTs = m.ts;
    const label = m.ts === undefined ? null : timeLabel(m.ts);
    const assistant = m.role === "assistant" && !m.tool;
    const assistantCode = assistant && m.text.trimStart().startsWith("```");
    return <div key={m.id} className={`group relative ${assistantCode ? "pt-6" : ""}`}>
      {separator && <div className="py-1 text-center text-[10.5px] text-fg-subtle">{label}</div>}
      <MessageRow m={m} latestTodo={m.id === lastTodo} />
      {label && <time dateTime={new Date(m.ts!).toISOString()} className="pointer-events-none absolute -top-3 right-1 text-[10px] text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100">{label}</time>}
      {assistant && <button type="button" aria-label="Copy assistant message" onClick={(e) => copyMessage(e.currentTarget, m.text)} className="absolute right-1 top-1 z-10 rounded bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted opacity-0 shadow-sm transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent">Copy</button>}
    </div>;
  });
  const onCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-copy-code]")) onCopyCode(e);
  }, [onCopyCode]);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(stick.current);
  }, [stick]);
  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [stick]);
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions" onScroll={onScroll} className="h-full overflow-y-auto px-3 py-3">
        <div ref={content} onClick={onCopyClick} className={`flex min-h-full flex-col justify-end gap-3 ${wide}`}>
          {loadError && !chat && (
            <div role="alert" className="grid flex-1 place-items-center text-center">
              <div>
                <p className="text-[13px] font-medium">Could not load chat</p>
                <p className="mt-1 max-w-sm text-[12.5px] text-fg-muted">{loadError}</p>
                <Btn kind="primary" onClick={retry}><RotateCw className="size-3.5" />Retry</Btn>
              </div>
            </div>
          )}
          {chat && chat.total > msgs.length && <div className="flex items-center justify-center gap-2 py-1 text-[11.5px] text-fg-muted">
            <span>Showing last {msgs.length} of {chat.total}</span>
            {limit < 2000 && <button type="button" disabled={loadingEarlier} onClick={() => { const el = scroller.current; if (el) restoreScroll.current = { top: el.scrollTop, height: el.scrollHeight }; loadEarlier(); }}
              className="font-medium text-accent hover:underline disabled:opacity-50">{loadingEarlier ? "Loading…" : "Show earlier"}</button>}
          </div>}
          {chat && !live && !msgs.length && (
            <div className="grid flex-1 place-items-center text-center">
              <div>
                <p className="text-[13px] font-medium">{chat.session ? "Session is not running in herdr" : "No manager session yet"}</p>
                <p className="mt-1 text-[12.5px] text-fg-muted">Chat always talks to a Claude session in herdr.</p>
                <div className="mt-3 flex justify-center gap-2">
                  {chat.session && <Btn disabled={busy} onClick={() => start(true)}><RotateCw className="size-3.5" />Resume</Btn>}
                  <Btn kind="primary" disabled={busy} onClick={() => start(false)}><Plus className="size-3.5" />New session</Btn>
                </div>
              </div>
            </div>
          )}
          {!chat && !loadError && <div className="text-center text-[13px] text-fg-muted">Loading chat…</div>}
          {renderedRows}
          {(chat?.queued ?? []).map((q, i) => <UserBubble key={`q${i}`} text={q} queued />)}
          {pending.map((p) => <UserBubble key={p.key} text={p.text} local={p.imgs} queued={st === "working"} />)}
          {chat?.prompt && <AskCard key={promptSignature(chat.prompt)} prompt={chat.prompt} send={answer} busy={busy} />}
          {live && !chat?.prompt && (st === "working" || (activity?.background ?? 0) > 0) && (
            <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-subtle">
              <Dot on={st === "working"} pulse color="var(--warning)" />
              <span className="min-w-0 truncate">{st === "working" ? (activity?.running ? `Running ${activity.running.name}${activity.running.detail ? ` · ${activity.running.detail}` : ""}` : "Thinking…") : "Waiting on background tasks"}</span>
              {(activity?.background ?? 0) > 0 && <><span aria-hidden className="shrink-0 text-fg-subtle">·</span><span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-fg-muted">{activity!.background} in background</span></>}
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button type="button" aria-label="Scroll to latest" title="Jump to latest" onClick={jump}
            className="fade-up pointer-events-auto z-[5] grid size-7 place-items-center rounded-full border border-border bg-surface text-fg-muted shadow-[var(--shadow-lg)] transition-colors hover:bg-hover hover:text-fg"><ArrowDown className="size-4" /></button>
        </div>
      )}
    </div>
  );
});

const STATUS: Record<string, { label: string; color: string }> = {
  working: { label: "Working", color: "var(--warning)" },
  idle: { label: "Idle", color: "var(--success)" },
  done: { label: "Idle", color: "var(--success)" },
  blocked: { label: "Waiting for your answer", color: "var(--danger)" },
  unknown: { label: "Unknown", color: "var(--fg-subtle)" },
};

type Meter = { pct: number; reset?: string };
const heat = (p: number) => (p < 60 ? "var(--success)" : p < 85 ? "var(--warning)" : "var(--danger)");

/** Donut: share of the context window in use. */
function Ring({ pct, title, size = 18 }: { pct: number; title: string; size?: number }) {
  const r = (size - 4) / 2, c = 2 * Math.PI * r;
  return (
    <span title={title} className="flex items-center gap-1.5 text-[11px] tabular-nums text-fg-muted">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={heat(pct)} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(c * Math.min(pct, 100)) / 100} ${c}`} className="transition-[stroke-dasharray] duration-500" />
      </svg>
      {pct}%
    </span>
  );
}

function Limit({ label, m }: { label: string; m: Meter }) {
  return (
    <span title={`${label} limit: ${m.pct}% used${m.reset ? `, resets in ${m.reset}` : ""}`} className="flex items-center gap-1 tabular-nums">
      <span className="font-medium">{label}</span>
      <span className="h-1 w-7 shrink-0 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(m.pct, 100)}%`, background: heat(m.pct) }} /></span>
      <span>{m.pct}%</span>
      {m.reset && <span className="text-fg-subtle">↻{m.reset}</span>}
    </span>
  );
}

/** Chat with the workspace's manager Claude session, which lives in herdr. Reads its transcript, writes through `herdr agent prompt`. */
export function ChatPanel({ ws, toast, max, onToggleMax, onMinimize, visible }: { ws: Workspace; toast: (m: string) => void; max: boolean; onToggleMax: () => void; onMinimize: () => void; visible: boolean }) {
  const wide = max ? "mx-auto w-full max-w-3xl" : "";
  const [chat, setChat] = useState<Chat | null>(null);
  const [limit, setLimit] = useState(300);
  const limitRef = useRef(300);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const failureCount = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const hasLoaded = useRef(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  type Att = { id: string; name: string; blob: string; path?: string };
  const [files, setFiles] = useState<Att[]>([]);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [optimisticModel, setOptimisticModel] = useState<{ value: string; base: string | null } | null>(null);
  const modelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const answerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const answeringPrompt = useRef<string | null>(null);
  const lastCmdFetch = useRef(0);
  const previousQ = useRef<string | null>(null);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [sel, setSel] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const hadPrompt = useRef(false);
  const base = `/api/ws/${ws.id}/chat`;

  const seq = useRef(0);
  const inflight = useRef(false);
  const firstLoad = useRef(true);
  const lastRev = useRef<string | null>(null);
  const previous = useRef<Chat | null>(null);
  const load = useCallback((requestedLimit = limitRef.current) => {
    const mine = ++seq.current;
    inflight.current = true;
    const done = () => { if (mine === seq.current) inflight.current = false; };
    return api<Chat>(`${base}?limit=${requestedLimit}`).then((d) => {
      if (mine === seq.current) {
        hasLoaded.current = true;
        failureCount.current = 0;
        setConsecutiveFailures(0);
        setLoadError(null);
        if (d.rev !== lastRev.current) {
          const old = previous.current;
          if (old) {
            const byId = new Map(old.messages.map((m) => [m.id, m]));
            d.messages = d.messages.map((m) => {
              const prior = byId.get(m.id);
              return prior && JSON.stringify(prior) === JSON.stringify(m) ? prior : m;
            });
          }
          lastRev.current = d.rev;
          previous.current = d;
          setChat(d);
        }
      }
      const outcome = firstLoadOutcome(mine, seq.current, firstLoad.current, false);
      if (outcome === "loaded") { firstLoad.current = false; setLoadError(null); }
      done();
    }).catch((e: unknown) => {
      if (firstLoadOutcome(mine, seq.current, firstLoad.current, true) === "failed") setLoadError(e instanceof Error ? e.message : String(e));
      if (mine === seq.current) {
        failureCount.current++;
        setConsecutiveFailures(failureCount.current);
        if (!hasLoaded.current) setLoadError(e instanceof Error ? e.message : String(e));
      }
      done();
    });
  }, [base]);
  const retry = useCallback(() => { load(); }, [load]);

  const loadEarlier = useCallback(() => {
    if (loadingEarlier || limit >= 2000) return;
    const next = Math.min(limit + 300, 2000);
    setLoadingEarlier(true);
    setLimit(next);
    limitRef.current = next;
    load(next).finally(() => setLoadingEarlier(false));
  }, [limit, loadingEarlier, load]);
  useEffect(() => {
    lastRev.current = null; previous.current = null; firstLoad.current = true; hasLoaded.current = false;
    failureCount.current = 0; setConsecutiveFailures(0); setLoadError(null); limitRef.current = 300; setLimit(300);
    setChat(null); setPending([]);
  }, [base, ws.manager]);
  useEffect(() => {
    if (!visible) return;
    load();
    const t = setInterval(() => { if (!document.hidden && !inflight.current) load(); }, 1500);
    return () => clearInterval(t);
  }, [load, visible, ws.manager]);
  const refreshCommands = useCallback(() => { lastCmdFetch.current = Date.now(); api<Cmd[]>(`${base}/commands`).then(setCmds).catch(() => {}); }, [base]);
  const q = /^\/\S*$/.test(text) && !menuOff ? text.slice(1).toLowerCase() : null;
  useEffect(() => {
    if (q !== null && previousQ.current === null && Date.now() - lastCmdFetch.current >= 5000) refreshCommands();
    previousQ.current = q;
  }, [q, refreshCommands]);
  useEffect(() => { refreshCommands(); }, [refreshCommands]);
  useEffect(() => {
    if (optimisticModel && (chat?.model ?? null) !== optimisticModel.base) { setOptimisticModel(null); clearTimeout(modelTimer.current); }
  }, [chat?.model, optimisticModel]);
  useEffect(() => () => { clearTimeout(modelTimer.current); clearTimeout(answerTimer.current); }, []);
  useEffect(() => {
    const signature = chat?.prompt ? promptSignature(chat.prompt) : null;
    if (answeringPrompt.current !== null && signature !== answeringPrompt.current) {
      answeringPrompt.current = null;
      clearTimeout(answerTimer.current);
      setBusy(false);
    }
  }, [chat?.prompt]);
  const answer = useCallback(async (a: Answer) => {
    if (busy || answeringPrompt.current !== null || !chat?.prompt) return;
    answeringPrompt.current = promptSignature(chat.prompt);
    setBusy(true);
    clearTimeout(answerTimer.current);
    answerTimer.current = setTimeout(() => { answeringPrompt.current = null; setBusy(false); }, 3000);
    try {
      await api(`${base}/answer`, { body: a });
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      await load();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e));
      clearTimeout(answerTimer.current); answeringPrompt.current = null; setBusy(false);
    }
  }, [base, busy, chat?.prompt, load, toast]);
  useEffect(() => {
    const onDrag = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    addEventListener("dragover", onDrag); addEventListener("drop", onDrag);
    return () => { removeEventListener("dragover", onDrag); removeEventListener("drop", onDrag); };
  }, []);
  useEffect(() => {
    if (hadPrompt.current && !chat?.prompt && (!document.activeElement || document.activeElement === document.body || (document.activeElement instanceof HTMLElement && document.activeElement.closest('[role="group"][aria-label^="Claude is waiting"]')))) input.current?.focus();
    hadPrompt.current = !!chat?.prompt;
  }, [chat?.prompt]);
  useEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [text]);
  useEffect(() => { setPending((ps) => reconcilePending(ps, chat?.messages ?? [], chat?.queued ?? [])); }, [chat]);

  const act = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await load(); } catch (e: unknown) { toast(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, [load, toast]);
  const start = useCallback((resume: boolean) => act(() => api(`${base}/start`, { body: { resume } }), resume ? "Session resumed in herdr" : "New session started in herdr"), [act, base]);
  const addFiles = (list: File[]) => {
    let slots = Math.max(0, 6 - files.length);
    for (const f of list) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(`${f.name}: unsupported file type; use PNG, JPEG, GIF, or WebP.`); continue; }
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name}: file exceeds the 10 MB limit.`); continue; }
      if (!slots) { toast(`${f.name}: maximum 6 image attachments.`); continue; }
      slots--;
      const id = crypto.randomUUID(), blob = URL.createObjectURL(f);
      setFiles((a) => [...a, { id, name: f.name, blob }]);
      const failed = () => { URL.revokeObjectURL(blob); setFiles((a) => a.filter((x) => x.id !== id)); };
      const rd = new FileReader();
      rd.onload = () => api<{ path: string }>(`${base}/upload`, { body: { name: f.name, mime: f.type, data: String(rd.result).split(",")[1] } })
        .then((r) => setFiles((a) => a.map((x) => (x.id === id ? { ...x, path: r.path } : x))))
        .catch((e: unknown) => { toast(e instanceof Error ? e.message : String(e)); failed(); });
      rd.onerror = () => { toast(`${f.name}: could not read image.`); failed(); };
      rd.readAsDataURL(f);
    }
  };
  const uploading = files.some((f) => !f.path);
  const mention = (p: string) => (p.includes(" ") ? `@"${p}"` : `@${p}`);
  const send = (raw = text, interrupt = false) => {
    const programmatic = raw !== text, typed = raw.trim(), atts = programmatic ? [] : files;
    if ((!typed && !atts.length) || busy || consecutiveFailures >= 3 || atts.some((f) => !f.path)) return;
    const t = [typed || "Please look at the attached image" + (atts.length > 1 ? "s." : "."), ...atts.map((f) => mention(f.path!))].join("\n");
    const key = crypto.randomUUID(), after = (chat?.messages ?? []).filter((m) => m.role === "user").at(-1)?.id ?? null;
    if (!programmatic) { setText(""); setFiles([]); setPending((ps) => [...ps, { key, text: t, imgs: atts.map((f) => f.blob), after }]); stick.current = true; }
    api(base, { body: { text: t, interrupt } }).then(() => { load(); if (typed.startsWith("/reload-plugins")) refreshCommands(); }).catch((e: unknown) => {
      if (!programmatic) { setPending((ps) => ps.filter((p) => p.key !== key)); setText((current) => current ? `${typed}\n${current}` : typed); setFiles(atts); }
      toast(e instanceof Error ? e.message : String(e));
    });
  };
  const matches = q === null ? [] : cmds.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)));
  const pick = (c: Cmd) => { setText(`/${c.name} `); setSel(0); input.current?.focus(); };
  const st = chat?.prompt ? "blocked" : chat?.status ?? "offline";
  const reconnecting = consecutiveFailures >= 3;
  const failedInitialLoad = !chat && !!loadError;
  const live = !!chat?.pane, meta = STATUS[st], msgs = chat?.messages ?? [];
  const models = useMemo(() => [...new Set([chat?.model, ...(ws.settings?.harnesses?.claude?.models ?? ["sonnet", "opus", "haiku"])].filter(Boolean) as string[])], [chat?.model, ws.settings]);
  const chooseModel = (m: string) => {
    if (!live || chat?.prompt || chat?.status === "blocked" || chat?.status === "working") return;
    setOptimisticModel({ value: m, base: chat?.model ?? null });
    clearTimeout(modelTimer.current);
    modelTimer.current = setTimeout(() => setOptimisticModel(null), 15000);
    api(base, { body: { text: `/model ${m}` } }).then(() => load()).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));
  };
  const lastTodo = useMemo(() => [...msgs].reverse().find((m) => m.tool?.todos)?.id, [msgs]);
  const activity = chat?.activity;
  const suggestion = chat?.suggestion && !text && !pending.length && (st === "idle" || st === "done") ? chat.suggestion : null;
  const useSuggestion = () => { if (!suggestion) return; setText(suggestion); input.current?.focus(); };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dragDepth.current++; setDrag(true); } }}
      onDragLeave={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrag(false); } }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); dragDepth.current = 0; setDrag(false); addFiles([...e.dataTransfer.files]); } }}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Dot on={live && !reconnecting && !failedInitialLoad} color={reconnecting || failedInitialLoad ? "var(--fg-subtle)" : meta?.color} pulse={st === "working" && !reconnecting} />
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-semibold">Manager</span>
          <span className="ml-2 text-[11.5px] text-fg-subtle" title={chat?.session ?? undefined}>{reconnecting ? "Reconnecting…" : failedInitialLoad ? "Connection error" : live ? meta?.label : chat?.session ? "Not running in herdr" : "No session"}</span>
        </div>
        {chat?.session && !live && <Btn kind="ghost" size="icon" title="Resume this session in herdr" disabled={busy} onClick={() => start(true)}><Play className="size-3.5" /></Btn>}
        <Btn kind="ghost" size="icon" title="Start a new session in herdr" disabled={busy} onClick={() => start(false)}><Plus className="size-4" /></Btn>
        <span className="hidden lg:contents"><Btn kind="ghost" size="icon" title={max ? "Restore chat size" : "Maximize chat"} onClick={onToggleMax}>{max ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</Btn></span>
        <Btn kind="ghost" size="icon" title="Collapse chat" onClick={onMinimize}><PanelLeftClose className="size-4" /></Btn>
      </div>

      <ChatThread chat={chat} pending={pending} st={st} live={live} busy={busy} wide={wide} lastTodo={lastTodo} activity={activity} start={start} answer={answer} stick={stick}
        limit={limit} loadEarlier={loadEarlier} loadingEarlier={loadingEarlier} loadError={loadError} retry={retry} />

      <div className="shrink-0 px-3 pt-1 pb-3">
        <div className={wide}>
          {suggestion && <button type="button" aria-label="Use suggested prompt" onClick={useSuggestion}
            className="mb-1 flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-left text-[11.5px] text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_35%,transparent)]">
            <span className="shrink-0">Suggested</span><span className="min-w-0 flex-1 truncate">{suggestion}</span><span className="shrink-0 text-fg-subtle">Tab to use</span>
          </button>}
          <form onSubmit={(e) => { e.preventDefault(); send(); }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
            className={`relative rounded-2xl border bg-surface shadow-[var(--shadow)] transition focus-within:border-border-strong focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] ${drag ? "border-accent" : "border-border"}`}>
            {files.length > 0 && <div className="flex flex-wrap gap-2 px-3 pt-3">{files.map((f) => <div key={f.id} className="relative" aria-busy={!f.path}>
              <img src={f.blob} alt={f.name} className={`size-14 rounded-lg border border-border object-cover ${f.path ? "" : "opacity-50"}`} />
              {!f.path && <span aria-label={`Uploading ${f.name}`} className="absolute inset-0 grid place-items-center"><span className="size-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /></span>}
              <button type="button" aria-label={`remove ${f.name}`} onClick={() => setFiles((a) => a.filter((x) => x.id !== f.id))} className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-fg-muted hover:text-fg"><X className="size-3" /></button>
            </div>)}</div>}
            {matches.length > 0 && <div id="chat-command-listbox" role="listbox" aria-label="commands" className="absolute right-0 bottom-full left-0 z-10 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-lg)]">
              {matches.map((c, i) => <button key={c.name} id={`chat-command-option-${i}`} ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined} type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}
                className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left ${i === sel ? "bg-hover" : ""}`}>
                <span className="shrink-0 font-mono text-[12.5px] text-fg">/{c.name}</span><span className="truncate text-[11.5px] text-fg-subtle">{c.desc}</span>
              </button>)}
            </div>}
            <textarea ref={input} value={text} onChange={(e) => { setText(e.target.value); setSel(0); setMenuOff(false); }} rows={1} disabled={!live || !!chat?.prompt || reconnecting} aria-label="message"
              aria-controls={matches.length ? "chat-command-listbox" : undefined} aria-activedescendant={matches.length ? `chat-command-option-${sel}` : undefined}
              placeholder={chat?.prompt ? "Answer the question above…" : live ? "Message the manager…  ( / for commands )" : "Start or resume a session to chat"}
              onPaste={(e) => { const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/")); if (imgs.length && !e.clipboardData.getData("text/plain")) { e.preventDefault(); addFiles(imgs); } }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Tab" && !e.shiftKey && suggestion && !text) { e.preventDefault(); useSuggestion(); return; }
                if (matches.length) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSel((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return; }
                  if (e.key === "Enter" && !e.shiftKey && text.slice(1) !== matches[sel].name) { e.preventDefault(); pick(matches[sel]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setMenuOff(true); return; }
                }
                if (e.key === "Escape") { if (st === "working") { e.preventDefault(); act(() => api(`${base}/interrupt`, { method: "POST" })); } return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (uploading) toast("Wait for image uploads to finish before sending."); else send(text, (e.ctrlKey || e.metaKey) && st === "working"); }
              }}
              className="no-ring block max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[16px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle disabled:opacity-50 sm:text-[13.5px]" />
            <div className="flex items-center gap-1 px-2 pb-2">
              <Select variant="bare" className="h-7 max-w-[200px] px-2! py-0! text-[12px] text-fg-muted" ariaLabel="model" value={optimisticModel?.value ?? chat?.model ?? ""} disabled={!live || st === "working" || !!chat?.prompt || st === "blocked"}
                options={models.map((m) => ({ value: m, label: m }))} onChange={chooseModel} placeholder="Model" />
              <button type="button" title="Attach image (or paste / drop one)" aria-label="Attach image" disabled={!live || !!chat?.prompt} onClick={() => picker.current?.click()}
                className="grid size-7 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"><Paperclip className="size-4" /></button>
              <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
              <span className="ml-auto" />
              {live && st === "working" && !text.trim() && !files.length
                ? <button type="button" title="Interrupt (Esc)" aria-label="Interrupt" disabled={busy} onClick={() => act(() => api(`${base}/interrupt`, { method: "POST" }))} className="grid size-7 place-items-center rounded-full border border-border text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"><Square className="size-3 fill-current" /></button>
                : <button type="submit" title={uploading ? "Wait for image uploads to finish" : live && st === "working" ? "Queue message (Enter) · Ctrl+Enter interrupts and sends" : "Send"} aria-label="Send" disabled={!live || reconnecting || (!text.trim() && !files.length) || uploading} className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-25"><ArrowUp className="size-4" strokeWidth={2.25} /></button>}
            </div>
          </form>
          {(chat?.usage?.ctx || chat?.usage?.h5 || chat?.usage?.d7) && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-fg-muted">
            {chat.usage.ctx && <Ring pct={chat.usage.ctx.pct} title={`Context ${chat.usage.ctx.pct}% · ${chat.usage.ctx.used} / ${chat.usage.ctx.size}`} />}
            {chat.usage.h5 && <Limit label="5h" m={chat.usage.h5} />}
            {chat.usage.d7 && <Limit label="7d" m={chat.usage.d7} />}
          </div>}
        </div>
      </div>
    </div>
  );
}
