import { ArrowDown, ArrowUp, Maximize2, Minimize2, PanelLeftClose, Paperclip, Play, Plus, RotateCw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Workspace } from "./api";
import { AnswerLog, AskCard, type Answer, type Prompt } from "./ask";
import { AgentCard, NoticeRow, TodoCard, ToolRow, UserBubble, type Activity, type Msg } from "./thread";
import { Select } from "./select";
import { Btn, Dot, Md } from "./ui";

type Chat = { session: string | null; pane?: string | null; status: string; model?: string | null; activity?: Activity; queued?: string[]; prompt?: Prompt | { raw: string } | null; usage?: { ctx: (Meter & { used: string; size: string }) | null; h5: Meter | null; d7: Meter | null } | null; messages: Msg[] };
type Cmd = { name: string; desc: string };

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
export function ChatPanel({ ws, toast, max, onToggleMax, onMinimize }: { ws: Workspace; toast: (m: string) => void; max: boolean; onToggleMax: () => void; onMinimize: () => void }) {
  const wide = max ? "mx-auto w-full max-w-3xl" : "";
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState("");
  type Pending = { key: string; text: string; imgs: string[]; after: string | null };
  const [pending, setPending] = useState<Pending[]>([]);
  type Att = { id: string; name: string; blob: string; path?: string };
  const [files, setFiles] = useState<Att[]>([]);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [sel, setSel] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const base = `/api/ws/${ws.id}/chat`;

  const seq = useRef(0);
  const inflight = useRef(false);
  const load = useCallback(() => {
    const mine = ++seq.current;
    inflight.current = true;
    const done = () => { if (mine === seq.current) inflight.current = false; };
    return api<Chat>(base).then((d) => { if (mine === seq.current) setChat(d); done(); }).catch(done);
  }, [base]);
  // ponytail: polling; the transcript file has no push channel. Swap for fs.watch + the existing /live socket if 1.5s feels slow.
  useEffect(() => {
    setChat(null); setPending([]); load();
    const t = setInterval(() => { if (!document.hidden && !inflight.current) load(); }, 1500);
    return () => clearInterval(t);
  }, [load, ws.manager]);
  useEffect(() => { api<Cmd[]>(`${base}/commands`).then(setCmds).catch(() => {}); }, [base]);
  useEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [text]); // autosize
  useEffect(() => {
    const users = (chat?.messages ?? []).filter((m) => m.role === "user");
    const queued = chat?.queued ?? [];
    setPending((ps) => {
      const next = ps.filter((p) => {
        if (queued.includes(p.text)) return false;
        const i = p.after ? users.findIndex((m) => m.id === p.after) : -1;
        return !(i >= 0 ? users.slice(i + 1) : users).some((m) => m.text === p.text);
      });
      return next.length === ps.length ? ps : next;
    });
  }, [chat]);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [chat?.messages.at(-1)?.id, pending.length, !!chat?.prompt]);
  useEffect(() => { const el = scroller.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }, [chat?.messages.at(-1)?.id, pending.length, !!chat?.prompt]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await load(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const start = (resume: boolean) => act(() => api(`${base}/start`, { body: { resume } }), resume ? "Session resumed in herdr" : "New session started in herdr");
  const answer = (a: Answer) => act(() => api(`${base}/answer`, { body: a }));
  /** Images go to the daemon first; the message then carries an @path mention, which Claude Code turns into an attachment. */
  const addFiles = (list: File[]) => {
    for (const f of list.filter((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.type))) {
      const id = crypto.randomUUID(), blob = URL.createObjectURL(f);
      setFiles((a) => [...a, { id, name: f.name, blob }]);
      const rd = new FileReader();
      rd.onload = () => api<{ path: string }>(`${base}/upload`, { body: { name: f.name, mime: f.type, data: String(rd.result).split(",")[1] } })
        .then((r) => setFiles((a) => a.map((x) => (x.id === id ? { ...x, path: r.path } : x))))
        .catch((e) => { toast(e.message); setFiles((a) => a.filter((x) => x.id !== id)); });
      rd.readAsDataURL(f);
    }
  };
  const uploading = files.some((f) => !f.path);
  const mention = (p: string) => (p.includes(" ") ? `@"${p}"` : `@${p}`);
  /** Enter queues the message (Claude takes it at its next pause, like in the terminal); `interrupt` stops the current turn first and sends now. */
  const send = (raw = text, interrupt = false) => {
    const typed = raw.trim(), atts = raw === text ? files : [];
    if ((!typed && !atts.length) || busy || atts.some((f) => !f.path)) return;
    const t = [typed || "Please look at the attached image" + (atts.length > 1 ? "s." : "."), ...atts.map((f) => mention(f.path!))].join("\n");
    const key = crypto.randomUUID(), after = (chat?.messages ?? []).filter((m) => m.role === "user").at(-1)?.id ?? null;
    setText(""); setFiles([]); setPending((ps) => [...ps, { key, text: t, imgs: atts.map((f) => f.blob), after }]); stick.current = true;
    api(base, { body: { text: t, interrupt } }).then(load).catch((e) => { setPending((ps) => ps.filter((p) => p.key !== key)); setText(typed); setFiles(atts); toast(e.message); });
  };
  // "/" + word (no space yet) opens the command menu
  const q = /^\/\S*$/.test(text) && !menuOff ? text.slice(1).toLowerCase() : null;
  const matches = q === null ? [] : cmds.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)));
  const pick = (c: Cmd) => { setText(`/${c.name} `); setSel(0); };
  const models = [...new Set([chat?.model, ...(ws.settings?.harnesses?.claude?.models ?? ["sonnet", "opus", "haiku"])].filter(Boolean) as string[])];

  const st = chat?.prompt ? "blocked" : chat?.status ?? "offline"; // a question on screen wins over herdr's own (laggy) status
  const live = !!chat?.pane;
  const meta = STATUS[st];
  const msgs = chat?.messages ?? [];
  const lastTodo = [...msgs].reverse().find((m) => m.tool?.todos)?.id;
  const activity = chat?.activity;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Dot on={live} color={meta?.color} pulse={st === "working"} />
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-semibold">Manager</span>
          <span className="ml-2 text-[11.5px] text-fg-subtle" title={chat?.session ?? undefined}>{live ? meta?.label : chat?.session ? "Not running in herdr" : "No session"}</span>
        </div>
        {chat?.session && !live && <Btn kind="ghost" size="icon" title="Resume this session in herdr" disabled={busy} onClick={() => start(true)}><Play className="size-3.5" /></Btn>}
        <Btn kind="ghost" size="icon" title="Start a new session in herdr" disabled={busy} onClick={() => start(false)}><Plus className="size-4" /></Btn>
        <span className="hidden lg:contents">
          <Btn kind="ghost" size="icon" title={max ? "Restore chat size" : "Maximize chat"} onClick={onToggleMax}>{max ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</Btn>
        </span>
        <Btn kind="ghost" size="icon" title="Collapse chat" onClick={onMinimize}><PanelLeftClose className="size-4" /></Btn>
      </div>

      <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setAtBottom(stick.current); }} className="h-full overflow-y-auto px-3 py-3">
        <div className={`flex min-h-full flex-col justify-end gap-3 ${wide}`}>
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
        {msgs.map((m) => m.role === "user" && !m.qa ? <UserBubble key={m.id} text={m.text} images={m.images} /> : m.qa ? <AnswerLog key={m.id} qa={m.qa} skipped={m.skipped} />
          : m.notice ? <NoticeRow key={m.id} n={m.notice} />
          : m.tool?.agent ? <AgentCard key={m.id} t={m.tool} />
          : m.tool?.todos ? <TodoCard key={m.id} t={m.tool} latest={m.id === lastTodo} />
          : m.tool ? <ToolRow key={m.id} t={m.tool} />
          : m.role === "user"
            ? <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] text-on-bubble">{m.text}</div>
            : <Md key={m.id} text={m.text} className="break-words" />)}
        {(chat?.queued ?? []).map((q, i) => <UserBubble key={`q${i}`} text={q} queued />)}
        {pending.map((p) => <UserBubble key={p.key} text={p.text} local={p.imgs} queued={st === "working"} />)}
        {chat?.prompt && <AskCard prompt={chat.prompt} send={answer} busy={busy} />}
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
          <button type="button" aria-label="Scroll to latest" title="Jump to latest" onClick={() => { const el = scroller.current; if (!el) return; stick.current = true; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }}
            className="fade-up pointer-events-auto z-[5] grid size-7 place-items-center rounded-full border border-border bg-surface text-fg-muted shadow-[var(--shadow-lg)] transition-colors hover:bg-hover hover:text-fg"><ArrowDown className="size-4" /></button>
        </div>
      )}
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3">
        <div className={wide}>
          <form onSubmit={(e) => { e.preventDefault(); send(); }}
            onDragOver={(e) => { if (live && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { setDrag(false); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } }}
            className={`relative rounded-2xl border bg-surface shadow-[var(--shadow)] transition focus-within:border-border-strong focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)] ${drag ? "border-accent" : "border-border"}`}>
            {files.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {files.map((f) => (
                  <div key={f.id} className="relative">
                    <img src={f.blob} alt={f.name} className={`size-14 rounded-lg border border-border object-cover ${f.path ? "" : "opacity-50"}`} />
                    <button type="button" aria-label={`remove ${f.name}`} onClick={() => setFiles((a) => a.filter((x) => x.id !== f.id))} className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-fg-muted hover:text-fg"><X className="size-3" /></button>
                  </div>
                ))}
              </div>
            )}
            {matches.length > 0 && (
              <div role="listbox" aria-label="commands" className="absolute right-0 bottom-full left-0 z-10 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-lg)]">
                {matches.map((c, i) => (
                  <button key={c.name} ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined} type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(c); }}
                    className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left ${i === sel ? "bg-hover" : ""}`}>
                    <span className="shrink-0 font-mono text-[12.5px] text-fg">/{c.name}</span>
                    <span className="truncate text-[11.5px] text-fg-subtle">{c.desc}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea ref={input} value={text} onChange={(e) => { setText(e.target.value); setSel(0); setMenuOff(false); }} rows={1} disabled={!live || !!chat?.prompt} aria-label="message"
              placeholder={chat?.prompt ? "Answer the question above…" : live ? "Message the manager…  ( / for commands )" : "Start or resume a session to chat"}
              onPaste={(e) => { const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (matches.length) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSel((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return; }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text.slice(1) !== matches[sel].name)) { e.preventDefault(); pick(matches[sel]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setMenuOff(true); return; }
                }
                if (e.key === "Escape") { if (st === "working") { e.preventDefault(); act(() => api(`${base}/interrupt`, { method: "POST" })); } return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text, (e.ctrlKey || e.metaKey) && st === "working"); }
              }}
              className="no-ring block max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle disabled:opacity-50" />
            <div className="flex items-center gap-1 px-2 pb-2">
              <Select variant="bare" className="h-7 max-w-[200px] px-2! py-0! text-[12px] text-fg-muted" ariaLabel="model" value={chat?.model ?? ""} disabled={!live || st === "working"}
                options={models.map((m) => ({ value: m, label: m }))} onChange={(m) => send(`/model ${m}`)} placeholder="Model" />
              <button type="button" title="Attach image (or paste / drop one)" aria-label="Attach image" disabled={!live || !!chat?.prompt} onClick={() => picker.current?.click()}
                className="grid size-7 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"><Paperclip className="size-4" /></button>
              <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
              <span className="ml-auto" />
              {live && st === "working" && !text.trim() && !files.length
                ? <button type="button" title="Interrupt (Esc)" aria-label="Interrupt" disabled={busy} onClick={() => act(() => api(`${base}/interrupt`, { method: "POST" }))} className="grid size-7 place-items-center rounded-full border border-border text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"><Square className="size-3 fill-current" /></button>
                : <button type="submit" title={live && st === "working" ? "Queue message (Enter) · Ctrl+Enter interrupts and sends" : "Send"} aria-label="Send" disabled={!live || (!text.trim() && !files.length) || uploading} className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-25"><ArrowUp className="size-4" strokeWidth={2.25} /></button>}
            </div>
          </form>
          {(chat?.usage?.ctx || chat?.usage?.h5 || chat?.usage?.d7) && (
            <div className="mt-2 flex items-center justify-between gap-2 overflow-hidden whitespace-nowrap px-1 text-[11px] text-fg-muted">
              {chat.usage.ctx && <Ring pct={chat.usage.ctx.pct} title={`Context ${chat.usage.ctx.pct}% · ${chat.usage.ctx.used} / ${chat.usage.ctx.size}`} />}
              {chat.usage.h5 && <Limit label="5h" m={chat.usage.h5} />}
              {chat.usage.d7 && <Limit label="7d" m={chat.usage.d7} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
