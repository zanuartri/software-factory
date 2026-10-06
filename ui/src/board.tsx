import { ChevronRight, Kanban, List, Search } from "lucide-react";
import { useState } from "react";
import { api, harnessOf, useApi, type FEvent, type Ticket, type Workspace } from "./api";
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

const Tag = ({ children }: { children: string }) => <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-fg-muted">{children}</span>;
const gaps = (t: Ticket) => (t.status === "draft" && t.brief_errors.length > 0 ? `${t.brief_errors.length} brief gap${t.brief_errors.length > 1 ? "s" : ""}` : null);

export function Board({ ws, openTicket, toast }: { ws: Workspace; openTicket: (id: string) => void; toast: (m: string) => void }) {
  const tickets = useApi<Ticket[]>(`/api/ws/${ws.id}/tickets`, (e: FEvent) => e.ws === ws.id && /ticket|store|gate|merge/.test(e.type));
  const [over, setOver] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [doneOpen, setDoneOpen] = useState(false);
  const [view, setView] = useState<"board" | "list">(() => { try { return localStorage.getItem("board-view") === "list" ? "list" : "board"; } catch { return "board"; } });
  const pickView = (v: "board" | "list") => { setView(v); try { localStorage.setItem("board-view", v); } catch {} };
  const dropProps = (c: string) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(c); },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => { setOver(null); const id = e.dataTransfer.getData("text/ticket"); if (id) move(id, c); },
  });

  const all = tickets.data ?? [];
  const needle = q.trim().toLowerCase();
  const shown = all.filter((t) => !needle || `${t.id} ${t.title} ${t.tags.join(" ")} ${t.harness} ${t.run?.harness ?? ""}`.toLowerCase().includes(needle));
  const move = async (id: string, status: string) => {
    try { await api(`/api/ws/${ws.id}/tickets/${id}`, { method: "PATCH", body: { status } }); tickets.reload(); }
    catch (e: any) { toast(`Can't move ${id} to ${STATUS_META[status].label}: ${e.message}${e.data?.brief_errors ? "\n• " + e.data.brief_errors.join("\n• ") : ""}`); }
  };
  return (
    <>
      <PageHeader title="Board" sub={needle ? `${shown.length} of ${all.length} tickets` : `${all.length} tickets`}>
        <label className="relative hidden md:block">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="filter tickets" className="h-8 w-36 rounded-lg border border-border bg-surface pr-2.5 pl-8 text-[13px] outline-none placeholder:text-fg-subtle focus:border-border-strong lg:w-48" />
        </label>
        <div role="radiogroup" aria-label="view" className="inline-flex rounded-lg bg-muted p-0.5">
          {([["board", Kanban, "Board"], ["list", List, "List"]] as const).map(([v, I, label]) => (
            <button key={v} role="radio" aria-checked={view === v} onClick={() => pickView(v)} title={label}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors ${view === v ? "bg-surface font-medium text-fg shadow-[var(--shadow)]" : "text-fg-muted hover:text-fg"}`}>
              <I className="size-3.5" /><span className="hidden xl:inline">{label}</span>
            </button>
          ))}
        </div>
      </PageHeader>

      {view === "list" ? <ListView tickets={shown} over={over} dropProps={dropProps} openTicket={openTicket} /> : (
        <div className="flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto p-3 md:p-4">
          {COLS.map((c) => {
            const list = shown.filter((t) => t.status === c);
            const rail = c === "done" && !doneOpen; // finished work is the bulk of any board: keep it as a thin rail until asked for
            if (rail) return (
              <button key={c} {...dropProps(c)} onClick={() => setDoneOpen(true)} aria-label={`${STATUS_META[c].label}, ${list.length} tickets — expand`} title="Show done tickets"
                className={`flex w-11 shrink-0 snap-start flex-col items-center gap-3 rounded-2xl border py-3.5 text-fg-muted transition-colors hover:text-fg ${over === c ? "border-accent/60 bg-hover" : "border-border bg-bg hover:bg-hover"}`}>
                <StatusIcon status={c} />
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums">{list.length}</span>
                <span className="text-[12.5px] font-semibold [writing-mode:vertical-rl]">{STATUS_META[c].label}</span>
              </button>
            );
            return (
              <section key={c} aria-label={STATUS_META[c].label} {...dropProps(c)}
                className={`flex min-h-0 min-w-[184px] flex-1 snap-start basis-0 flex-col rounded-2xl border transition-colors ${over === c ? "border-accent/60 bg-hover" : "border-border bg-bg"}`}>
                <header className="flex items-center gap-2 px-3.5 pt-3.5 pb-2.5">
                  <StatusIcon status={c} />
                  <h3 className="text-[13px] font-semibold">{STATUS_META[c].label}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-fg-muted tabular-nums">{list.length}</span>
                  {c === "done" && <button onClick={() => setDoneOpen(false)} title="Collapse" aria-label="Collapse done" className="ml-auto grid size-6 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"><ChevronRight className="size-3.5" /></button>}
                </header>
                <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-2.5">
                  {list.map((t) => (
                    <article key={t.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/ticket", t.id)} onClick={() => openTicket(t.id)}
                      className="card cursor-pointer p-3.5 transition hover:border-border-strong hover:shadow-[var(--shadow-lg)] active:cursor-grabbing">
                      <p className="line-clamp-3 text-[13px] leading-snug font-medium">{t.title}</p>
                      <div className="mt-2.5 flex items-center gap-2 text-[11.5px] text-fg-subtle">
                        <span className="font-mono">{t.id}</span>
                        <HarnessTag {...harnessOf(t)} />
                        <span className="ml-auto flex items-center gap-2"><StatusChip t={t} /><Priority p={t.priority} /></span>
                      </div>
                      {(t.tags.length > 0 || t.depends_on.length > 0 || (t.attempts ?? 0) > 1 || gaps(t)) && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {t.tags.map((g) => <Tag key={g}>{g}</Tag>)}
                          {t.depends_on.length > 0 && <span className="text-[11px] text-fg-subtle">after {t.depends_on.join(", ")}</span>}
                          {(t.attempts ?? 0) > 1 && <span className="text-[11px] text-warning">attempt {t.attempts}</span>}
                          {gaps(t) && <span className="text-[11px] text-fg-subtle">{gaps(t)}</span>}
                        </div>
                      )}
                    </article>
                  ))}
                  {!list.length && <p className="px-2 py-8 text-center text-[12px] text-fg-subtle">{needle ? "No match" : "Nothing here"}</p>}
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

/** Same outlined panels as the board lanes, stacked full width; rows draggable onto another group to change status. */
function ListView({ tickets, over, dropProps, openTicket }: { tickets: Ticket[]; over: string | null; dropProps: DropProps; openTicket: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done: true });
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:p-4">
      {COLS.map((c) => {
        const list = tickets.filter((t) => t.status === c);
        const closed = collapsed[c];
        return (
          <section key={c} aria-label={STATUS_META[c].label} {...dropProps(c)} className={`overflow-hidden rounded-2xl border transition-colors ${over === c ? "border-accent/60 bg-hover" : "border-border bg-bg"}`}>
            <button onClick={() => setCollapsed({ ...collapsed, [c]: !closed })} aria-expanded={!closed} className="flex h-11 w-full items-center gap-2 px-3.5 text-left hover:bg-hover">
              <ChevronRight className={`size-3.5 text-fg-subtle transition-transform ${closed ? "" : "rotate-90"}`} />
              <StatusIcon status={c} />
              <span className="text-[13px] font-semibold">{STATUS_META[c].label}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-fg-muted tabular-nums">{list.length}</span>
            </button>
            {!closed && (list.length ? list.map((t) => (
              <div key={t.id} role="button" tabIndex={0} draggable onDragStart={(e) => e.dataTransfer.setData("text/ticket", t.id)}
                onClick={() => openTicket(t.id)} onKeyDown={(e) => e.key === "Enter" && openTicket(t.id)}
                className="flex h-11 cursor-pointer items-center gap-3 border-t border-border px-3.5 transition-colors hover:bg-hover">
                <span className="grid w-4 shrink-0 place-items-center"><Priority p={t.priority} /></span>
                <span className="w-14 shrink-0 font-mono text-[12px] text-fg-subtle">{t.id}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.title}</span>
                <StatusChip t={t} />
                {gaps(t) && <span className="hidden text-[11px] text-fg-subtle sm:inline">{gaps(t)}</span>}
                {(t.attempts ?? 0) > 1 && <span className="text-[11px] text-warning">attempt {t.attempts}</span>}
                {t.depends_on.length > 0 && <span className="hidden text-[11px] text-fg-subtle xl:inline">after {t.depends_on.join(", ")}</span>}
                <span className="hidden items-center gap-1 lg:flex">{t.tags.map((g) => <Tag key={g}>{g}</Tag>)}</span>
                <HarnessTag {...harnessOf(t)} />
              </div>
            )) : <p className="border-t border-border px-3.5 py-3 text-[12px] text-fg-subtle">Nothing here</p>)}
          </section>
        );
      })}
    </div>
  );
}
