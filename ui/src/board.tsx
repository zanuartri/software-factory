import { ChevronRight, Kanban, List, Plus } from "lucide-react";
import { useState } from "react";
import { api, useApi, type FEvent, type Ticket, type Workspace } from "./api";
import { HarnessTag, PageHeader, STATUS_META, StatusChip, StatusIcon } from "./ui";

const COLS = ["draft", "open", "in_progress", "in_review", "done"] as const;
const PRIO: Record<string, { label: string; bars: number }> = { p0: { label: "Urgent", bars: 4 }, p1: { label: "High", bars: 3 }, p2: { label: "Medium", bars: 2 }, p3: { label: "Low", bars: 1 } };

function Priority({ p }: { p: string }) {
  const m = PRIO[p] ?? PRIO.p2;
  if (p === "p0") return <span title="Urgent" className="grid size-3.5 place-items-center rounded-[3px] bg-danger text-[9px] font-bold text-white">!</span>;
  return (
    <span title={m.label} className="flex h-3 items-end gap-[1.5px]">
      {[1, 2, 3].map((b) => <span key={b} className="w-[3px] rounded-[1px]" style={{ height: `${b * 33}%`, background: b <= m.bars ? "var(--fg-muted)" : "var(--border-strong)" }} />)}
    </span>
  );
}

export function Board({ ws, openTicket, toast }: { ws: Workspace; openTicket: (id: string) => void; toast: (m: string) => void }) {
  const tickets = useApi<Ticket[]>(`/api/ws/${ws.id}/tickets`, (e: FEvent) => e.ws === ws.id && /ticket|store|gate|merge/.test(e.type));
  const [over, setOver] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [view, setView] = useState<"board" | "list">(() => { try { return localStorage.getItem("board-view") === "list" ? "list" : "board"; } catch { return "board"; } });
  const pickView = (v: "board" | "list") => { setView(v); try { localStorage.setItem("board-view", v); } catch {} };
  const dropProps = (c: string) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(c); },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => { setOver(null); const id = e.dataTransfer.getData("text/ticket"); if (id) move(id, c); },
  });

  const move = async (id: string, status: string) => {
    try { await api(`/api/ws/${ws.id}/tickets/${id}`, { method: "PATCH", body: { status } }); tickets.reload(); }
    catch (e: any) { toast(`Can't move ${id} to ${STATUS_META[status].label}: ${e.message}${e.data?.brief_errors ? "\n• " + e.data.brief_errors.join("\n• ") : ""}`); }
  };
  const create = async () => {
    if (!newTitle.trim()) return;
    const t = await api<Ticket>(`/api/ws/${ws.id}/tickets`, { body: { title: newTitle } });
    setNewTitle(""); openTicket(t.id);
  };

  return (
    <>
      <PageHeader title="Board" sub={`${tickets.data?.length ?? 0} tickets`}>
        <div role="radiogroup" aria-label="view" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {([["board", Kanban, "Board"], ["list", List, "List"]] as const).map(([v, I, label]) => (
            <button key={v} role="radio" aria-checked={view === v} onClick={() => pickView(v)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors ${view === v ? "bg-muted font-medium text-fg" : "text-fg-muted hover:text-fg"}`}>
              <I className="size-3.5" /><span className="hidden md:inline">{label}</span>
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); create(); }} className="flex items-center gap-1.5">
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New ticket title…" aria-label="new ticket title"
            className="h-8 w-36 min-w-0 rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none placeholder:text-fg-subtle focus:border-border-strong md:w-64" />
          <button type="submit" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-fg hover:opacity-90"><Plus className="size-3.5" /><span className="hidden md:inline">New</span></button>
        </form>
      </PageHeader>
      {view === "list" ? <ListView tickets={tickets.data ?? []} over={over} dropProps={dropProps} openTicket={openTicket} /> : (
      <div className="grid min-h-0 flex-1 snap-x auto-cols-[minmax(230px,1fr)] grid-flow-col gap-3 overflow-x-auto p-3 md:p-4">
        {COLS.map((c) => {
          const list = (tickets.data ?? []).filter((t) => t.status === c);
          return (
            <section key={c} aria-label={STATUS_META[c].label} {...dropProps(c)}
              className={`flex min-h-0 snap-start flex-col rounded-xl transition-colors ${over === c ? "bg-hover" : "bg-muted/50"}`}>
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <StatusIcon status={c} />
                <h3 className="text-[13px] font-medium">{STATUS_META[c].label}</h3>
                <span className="text-[12px] text-fg-subtle tabular-nums">{list.length}</span>
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {list.map((t) => (
                  <article key={t.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/ticket", t.id)} onClick={() => openTicket(t.id)}
                    className="card cursor-pointer p-3 transition hover:border-border-strong active:cursor-grabbing">
                    <div className="flex items-center gap-2 text-[12px] text-fg-subtle">
                      <span className="font-mono">{t.id}</span>
                      <span className="ml-auto flex items-center gap-2"><StatusChip t={t} /><Priority p={t.priority} /></span>
                    </div>
                    <p className="mt-1 text-[13px] leading-snug font-medium">{t.title}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <HarnessTag h={t.harness} />
                      {t.tags.map((g) => <span key={g} className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-fg-muted">{g}</span>)}
                      {t.depends_on.length > 0 && <span className="text-[11px] text-fg-subtle">after {t.depends_on.join(", ")}</span>}
                      {(t.attempts ?? 0) > 1 && <span className="text-[11px] text-warning">attempt {t.attempts}</span>}
                    </div>
                    {c === "draft" && t.brief_errors.length > 0 && <p className="mt-2 text-[11px] text-fg-subtle">{t.brief_errors.length} brief gap{t.brief_errors.length > 1 ? "s" : ""}</p>}
                  </article>
                ))}
                {!list.length && <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">No tickets</p>}
              </div>
            </section>
          );
        })}
      </div>
      )}
    </>
  );
}

type DropProps = (c: string) => { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void };

/** Linear-style list: grouped by status, collapsible, rows draggable onto another group to change status. */
function ListView({ tickets, over, dropProps, openTicket }: { tickets: Ticket[]; over: string | null; dropProps: DropProps; openTicket: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done: true });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {COLS.map((c) => {
        const list = tickets.filter((t) => t.status === c);
        const closed = collapsed[c];
        return (
          <section key={c} aria-label={STATUS_META[c].label} {...dropProps(c)} className={over === c ? "bg-hover" : ""}>
            <button onClick={() => setCollapsed({ ...collapsed, [c]: !closed })} aria-expanded={!closed}
              className="sticky top-0 z-10 flex h-9 w-full items-center gap-2 border-b border-border bg-muted px-4 text-left md:px-6">
              <ChevronRight className={`size-3.5 text-fg-subtle transition-transform ${closed ? "" : "rotate-90"}`} />
              <StatusIcon status={c} />
              <span className="text-[13px] font-medium">{STATUS_META[c].label}</span>
              <span className="text-[12px] text-fg-subtle tabular-nums">{list.length}</span>
            </button>
            {!closed && list.map((t) => (
              <div key={t.id} role="button" tabIndex={0} draggable onDragStart={(e) => e.dataTransfer.setData("text/ticket", t.id)}
                onClick={() => openTicket(t.id)} onKeyDown={(e) => e.key === "Enter" && openTicket(t.id)}
                className="group flex h-11 cursor-pointer items-center gap-2.5 border-b border-border px-4 transition-colors hover:bg-hover md:gap-3 md:px-6">
                <span className="grid w-4 place-items-center"><Priority p={t.priority} /></span>
                <span className="w-12 shrink-0 font-mono text-[12px] text-fg-subtle md:w-14">{t.id}</span>
                <StatusIcon status={t.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.title}</span>
                <StatusChip t={t} />
                {c === "draft" && t.brief_errors.length > 0 && <span className="text-[11px] text-fg-subtle">{t.brief_errors.length} brief gap{t.brief_errors.length > 1 ? "s" : ""}</span>}
                {(t.attempts ?? 0) > 1 && <span className="text-[11px] text-warning">attempt {t.attempts}</span>}
                {t.depends_on.length > 0 && <span className="hidden text-[11px] text-fg-subtle lg:inline">after {t.depends_on.join(", ")}</span>}
                <span className="hidden items-center gap-1 md:flex">
                  {t.tags.map((g) => <span key={g} className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-fg-muted">{g}</span>)}
                </span>
                <HarnessTag h={t.harness} />
              </div>
            ))}
            {!closed && !list.length && <p className="border-b border-border px-4 py-3 text-[12px] text-fg-subtle md:px-6">No tickets</p>}
          </section>
        );
      })}
    </div>
  );
}
