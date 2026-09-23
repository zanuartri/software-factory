/// <reference types="vite/client" />
import { Bot, CircleDot, Kanban, ScrollText, Settings2 } from "lucide-react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApi, useConnected, type Workspace } from "./api";
import { Board } from "./board";
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
  const wss = useApi<Workspace[]>("/api/workspaces", (e) => /workspace|plan|coordinator/.test(e.type));
  const [route, go] = useRoute();
  const [toast, setToast] = useState<string | null>(null);
  const clear = useCallback(() => setToast(null), []);
  const connected = useConnected();
  const ws = wss.data?.find((w) => w.id === route.ws) ?? wss.data?.[0];
  const openTicket = (ticket: string) => go({ ws: ws?.id, ticket });
  const coordLive = !!ws?.coordinator && Date.now() - (ws.coordinator_seen ?? 0) < 15 * 60e3;

  return (
    <div className="grid h-full grid-cols-[56px_1fr] lg:grid-cols-[240px_1fr]">
      {/* below lg the sidebar is an icon rail: 700–1000px windows keep their width for content */}
      <nav className="flex min-h-0 flex-col items-center gap-1 border-r border-border bg-bg px-2 py-3 lg:items-stretch lg:px-3" aria-label="main">
        <div className="mb-3 w-full">
          <Select variant="bare" className="w-full justify-center lg:justify-start" chevronClass="hidden lg:block" ariaLabel="workspace" value={ws?.id ?? ""} onChange={(v) => go({ ws: v, ticket: null })}
            options={(wss.data ?? []).map((w) => ({ value: w.id, label: w.name, hint: w.path.split(/[\\/]/).slice(-2).join("/") }))}
            renderValue={() => (
              <span className="flex min-w-0 items-center gap-2.5 lg:flex-1" title={ws?.path}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-[12px] font-semibold text-primary-fg">{(ws?.name ?? "F")[0].toUpperCase()}</span>
                <span className="hidden min-w-0 flex-1 lg:block">
                  <span className="block truncate text-[13px] font-semibold">{ws?.name ?? "Factory"}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">{ws ? ws.path : "no workspace"}</span>
                </span>
              </span>
            )} />
        </div>

        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => go({ view: v.id, ticket: null })} aria-current={route.view === v.id ? "page" : undefined} title={v.label} aria-label={v.label}
            className={`relative flex size-9 items-center justify-center gap-2.5 rounded-lg text-[13px] font-medium transition-colors lg:h-8 lg:w-full lg:justify-start lg:px-2 ${route.view === v.id ? "bg-muted text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"}`}>
            <v.icon className="size-4" strokeWidth={1.75} />
            <span className="hidden lg:inline">{v.label}</span>
            {v.id === "floor" && ws?.plan?.active && <span className="absolute top-1.5 right-1.5 lg:static lg:ml-auto"><Dot on pulse /></span>}
          </button>
        ))}

        <div className="mt-auto flex flex-col items-center gap-3 pt-3 lg:items-stretch lg:px-2">
          <div className="flex flex-col items-center gap-2.5 text-[12px] text-fg-muted lg:items-stretch lg:gap-1.5">
            <div className="flex items-center gap-2" title={`Coordinator ${ws?.coordinator ?? "not attached"}`}><Dot on={coordLive} color="var(--h-claude)" /><span className="hidden lg:inline">Coordinator {ws?.coordinator ? <span className="font-mono text-fg-subtle">{ws.coordinator.slice(0, 8)}</span> : "—"}</span></div>
            <div className="flex items-center gap-2" title={connected ? "Connected" : "Reconnecting…"}><Dot on={connected} pulse={!connected} /><span className="hidden lg:inline">{connected ? "Connected" : "Reconnecting…"}</span></div>
          </div>
          <ThemeToggle />
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
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

      {ws && route.ticket && <TicketDrawer key={route.ticket} ws={ws} id={route.ticket} onClose={() => go({ ticket: null })} toast={setToast} />}
      <Toast msg={toast} onDone={clear} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
