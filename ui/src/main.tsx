/// <reference types="vite/client" />
import { Bot, CircleDot, Kanban, MessageSquare, PanelLeftOpen, ScrollText, Settings2 } from "lucide-react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApi, useConnected, type Workspace } from "./api";
import { Board } from "./board";
import { ChatPanel } from "./chat";
import { Floor } from "./floor";
import { Issues, Rules, Settings } from "./pages";
import "./styles.css";
import { TicketDrawer } from "./ticket";
import { Select } from "./select";
import { Dot, ThemeToggle, Toast } from "./ui";

const VIEWS = [
  { id: "floor", label: "Workers", icon: Bot },
  { id: "board", label: "Board", icon: Kanban },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "rules", label: "Rules", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;
type View = (typeof VIEWS)[number]["id"];

/** #/<ws>/<view>[/<ticket>] */
function useRoute() {
  const parse = () => { const [ws, view, ticket] = location.hash.replace(/^#\/?/, "").split("/"); return { ws: ws || null, view: (view || "floor") as View, ticket: ticket || null }; };
  const [r, setR] = useState(parse);
  useEffect(() => { const f = () => setR(parse()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const go = (p: Partial<typeof r>) => { const n = { ...r, ...p }; location.hash = `/${n.ws ?? ""}/${n.view}${n.ticket ? "/" + n.ticket : ""}`; };
  return [r, go] as const;
}

function App() {
  const wss = useApi<Workspace[]>("/api/workspaces", (e) => /workspace|plan|manager/.test(e.type));
  const [route, go] = useRoute();
  const [toast, setToast] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(() => innerWidth >= 1024);
  const [chatMax, setChatMax] = useState(false);
  const [chatW, setChatW] = useState(() => { try { return Math.min(Math.max(Number(localStorage.getItem("chatW")) || 400, 320), 900); } catch { return 400; } });
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX, startW = chatW;
    let w = startW;
    const move = (ev: PointerEvent) => { w = Math.min(Math.max(startW + ev.clientX - startX, 320), Math.min(900, innerWidth - 360)); setChatW(w); };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); document.body.style.userSelect = ""; try { localStorage.setItem("chatW", String(w)); } catch {} };
    document.body.style.userSelect = "none";
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const clear = useCallback(() => setToast(null), []);
  const connected = useConnected();
  const ws = wss.data?.find((w) => w.id === route.ws) ?? wss.data?.[0];
  const openTicket = (ticket: string) => go({ ws: ws?.id, ticket });

  return (
    <div className="flex h-full flex-col">
      <nav className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg px-3" aria-label="main">
        <Select variant="bare" className="w-auto max-w-[220px] shrink-0" ariaLabel="workspace" value={ws?.id ?? ""} onChange={(v) => go({ ws: v, ticket: null })}
          options={(wss.data ?? []).map((w) => ({ value: w.id, label: w.name, hint: w.path.split(/[\\/]/).slice(-2).join("/") }))}
          renderValue={() => (
            <span className="flex min-w-0 items-center gap-2" title={ws?.path}>
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-[12px] font-semibold text-primary-fg">{(ws?.name ?? "F")[0].toUpperCase()}</span>
              <span className="hidden truncate text-[13px] font-semibold sm:block">{ws?.name ?? "Factory"}</span>
            </span>
          )} />

        <div className="ml-1 flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => go({ view: v.id, ticket: null })} aria-current={route.view === v.id ? "page" : undefined} title={v.label} aria-label={v.label}
              className={`relative flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${route.view === v.id ? "bg-muted text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"}`}>
              <v.icon className="size-4" strokeWidth={1.75} />
              <span className="hidden md:inline">{v.label}</span>
              {v.id === "floor" && ws?.plan?.active && <Dot on pulse />}
            </button>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3 text-[12px] text-fg-muted">
          <div className="flex items-center gap-2" title={connected ? "Connected" : "Reconnecting…"}><Dot on={connected} pulse={!connected} /><span className="hidden xl:inline">{connected ? "Connected" : "Reconnecting…"}</span></div>
          <button onClick={() => { setChatOpen((o) => !o); setChatMax(false); }} aria-pressed={chatOpen} title="Toggle manager chat" aria-label="Toggle manager chat"
            className={`grid size-8 place-items-center rounded-lg transition-colors ${chatOpen ? "bg-muted text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"}`}><MessageSquare className="size-4" strokeWidth={1.75} /></button>
          <ThemeToggle />
        </div>
      </nav>

      <div className="relative flex min-h-0 flex-1">
        {/* chat is the left column on wide screens; below lg it covers the content */}
        {ws && chatOpen && (
          <aside className={`absolute inset-0 z-30 lg:relative lg:border-border ${chatMax ? "lg:min-w-0 lg:flex-1" : "lg:w-(--chat-w) lg:shrink-0 lg:border-r"}`} style={{ "--chat-w": `${chatW}px` } as React.CSSProperties} aria-label="manager chat">
            {!chatMax && <div onPointerDown={drag} onDoubleClick={() => { setChatW(400); try { localStorage.removeItem("chatW"); } catch {} }} role="separator" aria-orientation="vertical" aria-label="Resize chat" title="Drag to resize · double-click to reset"
              className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none transition-colors hover:bg-accent/30 active:bg-accent/40 lg:block" />}
            <ChatPanel key={ws.id} ws={ws} toast={setToast} max={chatMax} onToggleMax={() => setChatMax((x) => !x)} onMinimize={() => { setChatOpen(false); setChatMax(false); }} />
          </aside>
        )}

        {ws && !chatOpen && (
          <button onClick={() => setChatOpen(true)} title="Expand manager chat" aria-label="Expand manager chat"
            className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-border bg-bg py-3 text-fg-muted transition-colors hover:bg-hover hover:text-fg">
            <PanelLeftOpen className="size-4" strokeWidth={1.75} />
            <span className="text-[12px] font-medium [writing-mode:vertical-rl]">Manager chat</span>
          </button>
        )}

        <main className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${chatOpen && chatMax ? "hidden" : "flex"}`}>
          {!connected && ws && (
            <div role="alert" className="flex items-center gap-2 border-b px-4 py-2 text-[12.5px] md:px-6"
              style={{ color: "var(--warning)", borderColor: "color-mix(in srgb, var(--warning) 30%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
              <Dot on color="var(--warning)" pulse />
              <span className="truncate">Daemon offline<span className="hidden md:inline">. Data may be stale</span>. Run <code className="font-mono">factory up</code><span className="hidden md:inline">; this page reconnects on its own</span>.</span>
            </div>
          )}
          {!ws ? (
            <div className="grid h-full place-items-center">
              <div className="text-center">
                <p className="text-[15px] font-semibold">{wss.error ? "Daemon is offline" : "No workspace yet"}</p>
                <p className="mt-1 text-[13px] text-fg-muted">{wss.error ? <>Start it with <code className="font-mono">factory up</code></> : <>Open Claude Code in a repo and run <code className="font-mono">/factory:init</code></>}</p>
              </div>
            </div>
          ) : route.view === "floor" ? <Floor key={ws.id} ws={ws} openTicket={openTicket} openBoard={() => go({ view: "board", ticket: null })} toast={setToast} />
            : route.view === "board" ? <Board key={ws.id} ws={ws} openTicket={openTicket} toast={setToast} />
            : route.view === "issues" ? <Issues key={ws.id} ws={ws} openTicket={openTicket} toast={setToast} />
            : route.view === "rules" ? <Rules key={ws.id} ws={ws} toast={setToast} />
            : <Settings key={ws.id} ws={ws} toast={setToast} />}
        </main>
      </div>

      {ws && route.ticket && <TicketDrawer key={route.ticket} ws={ws} id={route.ticket} onClose={() => go({ ticket: null })} toast={setToast} />}
      <Toast msg={toast} onDone={clear} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
