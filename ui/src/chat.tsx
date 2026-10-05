import { ArrowUp, Maximize2, Minimize2, PanelLeftClose, Play, Plus, RotateCw, Square, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Workspace } from "./api";
import { Select } from "./select";
import { Btn, Dot, Md } from "./ui";

type Msg = { id: string; role: "user" | "assistant" | "tool"; text: string };
type Chat = { session: string | null; pane?: string | null; status: string; model?: string | null; usage?: { ctx: (Meter & { used: string; size: string }) | null; h5: Meter | null; d7: Meter | null } | null; messages: Msg[] };
type Cmd = { name: string; desc: string };

const STATUS: Record<string, { label: string; color: string }> = {
  working: { label: "Working", color: "var(--warning)" },
  idle: { label: "Idle", color: "var(--success)" },
  done: { label: "Idle", color: "var(--success)" },
  blocked: { label: "Needs input in herdr", color: "var(--danger)" },
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
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [sel, setSel] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const base = `/api/ws/${ws.id}/chat`;

  const load = useCallback(() => api<Chat>(base).then(setChat).catch(() => {}), [base]);
  // ponytail: polling; the transcript file has no push channel. Swap for fs.watch + the existing /live socket if 1.5s feels slow.
  useEffect(() => {
    setChat(null); setPending(null); load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 1500);
    return () => clearInterval(t);
  }, [load, ws.manager]);
  useEffect(() => { api<Cmd[]>(`${base}/commands`).then(setCmds).catch(() => {}); }, [base]);
  useEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [text]); // autosize
  useEffect(() => { setPending(null); }, [chat?.messages.length]);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [chat?.messages.length, pending]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await load(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const start = (resume: boolean) => act(() => api(`${base}/start`, { body: { resume } }), resume ? "Session resumed in herdr" : "New session started in herdr");
  const send = (raw = text) => {
    const t = raw.trim();
    if (!t || busy) return;
    setText(""); setPending(t); stick.current = true;
    api(base, { body: { text: t } }).then(load).catch((e) => { setPending(null); setText(t); toast(e.message); });
  };
  // "/" + word (no space yet) opens the command menu
  const q = /^\/\S*$/.test(text) && !menuOff ? text.slice(1).toLowerCase() : null;
  const matches = q === null ? [] : cmds.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)));
  const pick = (c: Cmd) => { setText(`/${c.name} `); setSel(0); };
  const models = [...new Set([chat?.model, ...(ws.settings?.harnesses?.claude?.models ?? ["sonnet", "opus", "haiku"])].filter(Boolean) as string[])];

  const st = chat?.status ?? "offline";
  const live = !!chat?.pane;
  const meta = STATUS[st];
  const msgs = chat?.messages ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
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

      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className={`space-y-3 ${wide} ${msgs.length ? "" : "h-full"}`}>
        {chat && !live && !msgs.length && (
          <div className="grid h-full place-items-center text-center">
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
        {msgs.map((m) => m.role === "tool"
          ? <div key={m.id} className="flex items-center gap-1.5 truncate font-mono text-[11px] text-fg-subtle"><Wrench className="size-3 shrink-0" /><span className="truncate">{m.text}</span></div>
          : m.role === "user"
            ? <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] text-on-bubble">{m.text}</div>
            : <Md key={m.id} text={m.text} className="break-words" />)}
        {pending && <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] text-on-bubble opacity-60">{pending}</div>}
        {live && st === "working" && <div className="flex items-center gap-1.5 text-[12px] text-fg-subtle"><Dot on pulse color="var(--warning)" />Thinking…</div>}
        </div>
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3">
        <div className={wide}>
          <form onSubmit={(e) => { e.preventDefault(); send(); }}
            className="relative rounded-2xl border border-border bg-surface shadow-[var(--shadow)] transition focus-within:border-border-strong focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)]">
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
            <textarea ref={input} value={text} onChange={(e) => { setText(e.target.value); setSel(0); setMenuOff(false); }} rows={1} disabled={!live} aria-label="message"
              placeholder={live ? "Message the manager…  ( / for commands )" : "Start or resume a session to chat"}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (matches.length) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSel((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return; }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text.slice(1) !== matches[sel].name)) { e.preventDefault(); pick(matches[sel]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setMenuOff(true); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              className="no-ring block max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle disabled:opacity-50" />
            <div className="flex items-center gap-1 px-2 pb-2">
              <Select variant="bare" className="h-7 max-w-[200px] px-2! py-0! text-[12px] text-fg-muted" ariaLabel="model" value={chat?.model ?? ""} disabled={!live || st === "working"}
                options={models.map((m) => ({ value: m, label: m }))} onChange={(m) => send(`/model ${m}`)} placeholder="Model" />
              <span className="ml-auto" />
              {live && st === "working"
                ? <button type="button" title="Interrupt (Esc)" aria-label="Interrupt" onClick={() => act(() => api(`${base}/interrupt`, { method: "POST" }))} className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg transition-opacity hover:opacity-90"><Square className="size-3 fill-current" /></button>
                : <button type="submit" title="Send" aria-label="Send" disabled={!live || !text.trim()} className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-25"><ArrowUp className="size-4" strokeWidth={2.25} /></button>}
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
