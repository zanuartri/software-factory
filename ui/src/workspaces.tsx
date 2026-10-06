import { FolderOpen, FolderPlus, MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Workspace } from "./api";
import { Btn, Dot, inputCls, PageHeader, STATUS_META, StatusIcon } from "./ui";

const COUNT_ORDER = ["draft", "open", "in_progress", "in_review", "done"] as const;
const MANAGER_LIVE_MS = 10 * 60e3; // same window the daemon uses to call a manager "live"

function Card({ w, open, remove }: { w: Workspace; open: () => void; remove: () => void }) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    addEventListener("pointerdown", down); addEventListener("keydown", key);
    return () => { removeEventListener("pointerdown", down); removeEventListener("keydown", key); };
  }, [menu]);
  const live = !!w.plan?.active;
  const mgr = !!w.manager && Date.now() - (w.manager_seen ?? 0) < MANAGER_LIVE_MS;
  const base = w.settings?.base_branch;
  const chips = COUNT_ORDER.filter((s) => w.counts?.[s]);
  return (
    <article className="card relative min-w-0 p-4 transition-colors focus-within:border-border-strong hover:border-border-strong">
      <div className="flex items-center gap-2.5 pr-8">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-[13px] font-semibold text-primary-fg">{(w.name || "F")[0].toUpperCase()}</span>
        <button onClick={open} title={`Open ${w.name}`} className="min-w-0 truncate rounded text-left text-[14px] font-semibold outline-none after:absolute after:inset-0 after:rounded-[14px] after:content-[''] focus-visible:after:ring-4 focus-visible:after:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]">{w.name}</button>
        {live && <span title="A plan is running"><Dot on pulse color="var(--accent)" /></span>}
      </div>
      <p className="mt-3 truncate font-mono text-[12px] text-fg-muted" title={w.path}>{w.path}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-subtle">
        {base && <span title="Base branch">branch <span className="font-mono text-fg-muted">{base}</span></span>}
        <span className="flex items-center gap-1.5" title={mgr ? "Manager session attached" : "No live manager session"}><Dot on={mgr} />{mgr ? "Manager live" : "No manager"}</span>
      </div>
      <div className="mt-3 flex min-h-5 flex-wrap gap-1.5">
        {chips.map((s) => (
          <span key={s} title={STATUS_META[s].label} aria-label={`${w.counts![s]} ${STATUS_META[s].label}`} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
            <StatusIcon status={s} size={11} />{w.counts![s]}<span className="hidden text-fg-subtle sm:inline">{STATUS_META[s].label}</span>
          </span>
        ))}
      </div>
      <div ref={box} className="absolute top-3 right-3 z-10">
        <Btn size="icon" kind="ghost" title={`Actions for ${w.name}`} onClick={() => setMenu((x) => !x)}><MoreHorizontal className="size-4" /></Btn>
        {menu && (
          <div role="menu" aria-label={`${w.name} actions`} className="fade-up absolute top-9 right-0 w-40 rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-lg)]">
            <button role="menuitem" autoFocus onClick={() => { setMenu(false); remove(); }} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-danger outline-none hover:bg-hover focus-visible:bg-hover">
              <Trash2 className="size-3.5" />Remove
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function AddCard({ add, toast }: { add: (path: string) => Promise<void>; toast: (m: string) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<"pick" | "add" | null>(null);
  const browse = async () => {
    setBusy("pick");
    try { const r = await api<{ path: string | null }>("/api/fs/pick-folder", { body: {} }); if (r.path) setPath(r.path); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  };
  const submit = async () => {
    const p = path.trim();
    if (!p) return;
    setBusy("add");
    try { await add(p); setPath(""); } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Add workspace" className="card flex min-w-0 flex-col gap-3 border-dashed p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-fg-muted"><FolderPlus className="size-4" strokeWidth={1.75} /></span>
        <span className="text-[14px] font-semibold">Add workspace</span>
      </div>
      <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Path to a git repo" aria-label="Repository path" spellCheck={false} autoComplete="off" title={path || undefined} className={`${inputCls} font-mono`} />
      <div className="flex gap-2">
        <Btn onClick={browse} disabled={busy !== null} title="Browse for a folder"><FolderOpen className="size-3.5" />{busy === "pick" ? "Choosing…" : "Browse"}</Btn>
        <Btn type="submit" kind="primary" disabled={busy !== null || !path.trim()}>{busy === "add" ? "Adding…" : "Add"}</Btn>
      </div>
    </form>
  );
}

export function Workspaces({ list, reload, open, toast }: { list: Workspace[]; reload: () => void; open: (id: string, view: "floor" | "board") => void; toast: (m: string) => void }) {
  const add = async (path: string) => {
    const w = await api<Workspace>("/api/workspaces", { body: { path } });
    reload(); toast(`Added ${w.name}`); open(w.id, "board");
  };
  const remove = (w: Workspace) => {
    if (!confirm(`Remove workspace ${w.name}? The repo on disk is not touched.`)) return;
    api(`/api/workspaces/${w.id}`, { method: "DELETE" }).then(() => { reload(); toast(`Removed ${w.name}`); }).catch((e: Error) => toast(e.message));
  };
  return (
    <>
      <PageHeader title="Workspaces" sub={`${list.length} registered`} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((w) => <Card key={w.id} w={w} open={() => open(w.id, "floor")} remove={() => remove(w)} />)}
          <AddCard add={add} toast={toast} />
        </div>
      </div>
    </>
  );
}
