import { ArrowUp, GitMerge, Pencil, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ago, api, harnessOf, LIVE, useApi, type FEvent, type Run, type Ticket, type Workspace } from "./api";
import { modelOpts, Select, type Opt } from "./select";
import { Btn, Dot, Empty, HARNESS_COLOR, HarnessTag, inputCls, Md, STATUS_META, StatusChip, StatusIcon, textareaCls } from "./ui";

const STATUS_OPTS: Opt[] = Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label, icon: <StatusIcon status={value} /> }));
const PRIORITY_OPTS: Opt[] = [["p0", "Urgent"], ["p1", "High"], ["p2", "Medium"], ["p3", "Low"]].map(([value, label]) => ({ value, label }));
const HARNESS_OPTS: Opt[] = ["any", "claude", "omp", "commandcode"].map((h) => ({ value: h, label: h === "any" ? "Any (scheduler picks)" : h, icon: <span className="size-2 rounded-full" style={{ background: HARNESS_COLOR[h] }} /> }));

const TABS = [["brief", "Brief"], ["report", "Report"], ["runs", "Runs"], ["diff", "Diff"]] as const;
const EDITABLE = ["Goal", "Context", "Acceptance", "Verify", "Timebox", "Forbidden"];

export function TicketDrawer({ ws, id, onClose, toast }: { ws: Workspace; id: string; onClose: () => void; toast: (m: string) => void }) {
  const t = useApi<Ticket>(`/api/ws/${ws.id}/tickets/${id}`, (e: FEvent) => e.ws === ws.id && (e.ticket === id || e.type === "store.changed"));
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("brief");
  const [tell, setTell] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const act = (p: Promise<any>, ok?: string) => p.then((r) => { if (ok) toast(ok + (r?.status ? `: ${r.status}` : "")); t.reload(); })
    .catch((e) => toast(e.message + (e.data?.brief_errors ? "\n• " + e.data.brief_errors.join("\n• ") : "")));
  const d = t.data;
  const liveRun = d?.runs?.find((r) => r.role === "worker" && LIVE.includes(r.status));
  const picked = useRef(false);
  useEffect(() => {
    if (!d || picked.current) return;
    picked.current = true;
    if ((d.status === "in_review" || d.status === "done") && d.sections.Report) setTab("report");
  }, [d]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20 backdrop-blur-[1px]" onClick={onClose}>
      <aside role="dialog" aria-label={`ticket ${id}`} onClick={(e) => e.stopPropagation()}
        className="slide-in m-2 flex w-[min(820px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-lg)]">
        {!d ? <div className="p-6 text-[13px] text-fg-subtle">{t.error ?? "Loading…"}</div> : (
          <>
            <header className="border-b border-border px-4 pt-4 pb-3 md:px-6">
              <div className="flex items-center gap-2 text-[12px] text-fg-subtle">
                <span className="font-mono">{d.id}</span>
                {d.branch && <span className="truncate font-mono">· {d.branch}</span>}
                <button onClick={onClose} className="ml-auto grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg" aria-label="close"><X className="size-4" /></button>
              </div>
              <h2 className="mt-1 text-lg font-semibold tracking-tight md:text-xl">{d.title}</h2>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Select variant="ghost" ariaLabel="status" value={d.status} options={STATUS_OPTS}
                  onChange={(v) => act(api(`/api/ws/${ws.id}/tickets/${id}`, { method: "PATCH", body: { status: v } }))} />
                <HarnessTag {...harnessOf(d, d.model)} />
                <StatusChip t={d} />
                <div className="ml-auto flex gap-2">
                  {(d.blocked || d.failed) && <Btn onClick={() => act(api(`/api/ws/${ws.id}/tickets/${id}`, { method: "PATCH", body: { blocked: null, failed: null } }))}>Clear flag</Btn>}
                  {d.status === "open" && !liveRun && <Btn onClick={() => act(api(`/api/ws/${ws.id}/tickets/${id}/spawn`, { body: {} }), "Worker started")}><Play className="size-3.5" />Start worker</Btn>}
                  {d.status === "in_review" && <Btn kind="primary" onClick={() => confirm(`Merge ${id} into ${ws.settings.base_branch}?`) && act(api(`/api/ws/${ws.id}/tickets/${id}/merge`, { body: {} }), "Merge")}><GitMerge className="size-3.5" />Merge</Btn>}
                </div>
              </div>
              {(d.blocked || d.failed) && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ color: d.failed ? "var(--danger)" : "var(--warning)", background: `color-mix(in srgb, ${d.failed ? "var(--danger)" : "var(--warning)"} 10%, transparent)` }}>{d.blocked ?? d.failed}</p>}

              <nav className="mt-4 inline-flex rounded-lg bg-muted p-0.5" role="tablist">
                {TABS.map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                    className={`h-7 rounded-md px-3 text-[12.5px] font-medium transition-colors ${tab === k ? "bg-surface text-fg shadow-[var(--shadow)]" : "text-fg-muted hover:text-fg"}`}>
                    {label}{k === "runs" && d.runs?.length ? <span className="ml-1.5 text-fg-subtle">{d.runs.length}</span> : null}
                  </button>
                ))}
              </nav>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
              {tab === "brief" && <Brief ws={ws} t={d} onSaved={t.reload} toast={toast} />}
              {tab === "report" && (d.sections.Report ? <Md text={d.sections.Report} /> : <Empty>No report yet. The worker writes it on submit and the gate appends its evidence.</Empty>)}
              {tab === "runs" && <Runs runs={d.runs ?? []} />}
              {tab === "diff" && <Diff ws={ws} id={id} />}
            </div>

            {d.status !== "done" && <form className="border-t border-border px-4 py-3 md:px-6" onSubmit={(e) => { e.preventDefault(); if (tell.trim()) act(api(`/api/ws/${ws.id}/tickets/${id}/tell`, { body: { text: tell } }), "Sent").then(() => setTell("")); }}>
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-bg py-1.5 pr-1.5 pl-3.5 transition focus-within:border-border-strong focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)]">
                <input value={tell} onChange={(e) => setTell(e.target.value)} placeholder={liveRun ? "Steer the worker…" : "Resume the worker with guidance…"} aria-label="message worker" className="no-ring h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
                <button type="submit" aria-label="Send" title="Send" disabled={!tell.trim()} className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-25"><ArrowUp className="size-4" strokeWidth={2.25} /></button>
              </div>
            </form>}
          </>
        )}
      </aside>
    </div>
  );
}

const L = ({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) => (
  <label className={`block ${className}`}><span className="mb-1 block text-[12px] font-medium text-fg-muted">{label}</span>{children}</label>
);

const PRIORITY_LABEL: Record<string, string> = { p0: "Urgent", p1: "High", p2: "Medium", p3: "Low" };

function Brief({ ws, t, onSaved, toast }: { ws: Workspace; t: Ticket; onSaved: () => void; toast: (m: string) => void }) {
  const [editing, setEditing] = useState(t.status === "draft" || t.brief_errors.length > 0);
  if (editing) return <BriefEditor ws={ws} t={t} toast={toast} onSaved={() => { onSaved(); if (t.status !== "draft") setEditing(false); }} onCancel={t.status === "draft" ? undefined : () => setEditing(false)} />;
  const hc = ws.settings.harnesses[t.harness === "any" ? ws.settings.default_harness : t.harness];
  const props: [string, React.ReactNode][] = [
    ["Priority", PRIORITY_LABEL[t.priority] ?? t.priority],
    ["Harness", <HarnessTag {...harnessOf(t)} />],
    ["Model", t.model !== "default" ? t.model : <span className="text-fg-muted">{hc?.model ? <>{hc.model} <span className="text-fg-subtle">· settings default</span></> : "Harness default"}</span>],
    ["Scope", <span className="font-mono text-[12px]">{t.scope_paths.join(", ") || "—"}</span>],
    ["Tags", t.tags.join(", ") || "—"],
    ["Depends on", t.depends_on.join(", ") || "—"],
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-4 rounded-2xl border border-border bg-bg p-4">
        <dl className="grid flex-1 grid-cols-[88px_1fr] gap-x-4 gap-y-2 text-[13px]">
          {props.map(([k, v]) => <div key={k} className="contents"><dt className="text-fg-subtle">{k}</dt><dd className="min-w-0 truncate">{v}</dd></div>)}
        </dl>
        <Btn onClick={() => setEditing(true)}><Pencil className="size-3.5" />Edit</Btn>
      </div>
      {EDITABLE.filter((k) => t.sections[k]?.trim()).map((k) => (
        <section key={k} className="rounded-2xl border border-border bg-bg p-4">
          <h3 className="mb-2 text-[12px] font-semibold text-fg-muted">{k}</h3>
          {k === "Verify"
            ? <pre className="overflow-x-auto rounded-xl border border-border bg-muted px-3 py-2 font-mono text-[12px] text-fg">{t.sections[k]}</pre>
            : <Md text={t.sections[k]} />}
        </section>
      ))}
    </div>
  );
}

function BriefEditor({ ws, t, onSaved, onCancel, toast }: { ws: Workspace; t: Ticket; onSaved: () => void; onCancel?: () => void; toast: (m: string) => void }) {
  const init = () => ({ title: t.title, priority: t.priority, tags: t.tags.join(", "), depends_on: t.depends_on.join(", "), scope_paths: t.scope_paths.join(", "), harness: t.harness, model: t.model, sections: { ...t.sections } });
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const save = () => api(`/api/ws/${ws.id}/tickets/${t.id}`, { method: "PATCH", body: { ...f, tags: list(f.tags), depends_on: list(f.depends_on), scope_paths: list(f.scope_paths) } }).then(onSaved).catch((e) => toast(e.message));
  return (
    <div className="space-y-5">
      {t.brief_errors.length > 0 && (
        <div className="rounded-lg border px-3 py-2.5 text-[12.5px]" style={{ borderColor: "color-mix(in srgb, var(--warning) 40%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
          <p className="font-medium text-warning">Brief incomplete — can't be released yet</p>
          <ul className="mt-1 list-disc pl-5 text-fg-muted">{t.brief_errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <L label="Title" className="col-span-2 md:col-span-6"><input className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></L>
        <L label="Priority" className="col-span-1 md:col-span-2"><Select ariaLabel="priority" value={f.priority} options={PRIORITY_OPTS} onChange={(v) => setF({ ...f, priority: v })} /></L>
        <L label="Harness" className="col-span-1 md:col-span-2"><Select ariaLabel="harness" value={f.harness} options={HARNESS_OPTS} onChange={(v) => setF({ ...f, harness: v as any, model: "default" })} /></L>
        <L label="Model" className="col-span-2 md:col-span-2"><Select ariaLabel="model" value={f.model} searchable onChange={(v) => setF({ ...f, model: v })}
          options={(() => { const hc = ws.settings.harnesses[f.harness === "any" ? ws.settings.default_harness : f.harness]; return modelOpts(hc?.models ?? [], "Settings default", "default", hc?.model || "CLI default"); })()} /></L>
        <L label="Scope paths" className="col-span-2 md:col-span-3"><input className={`${inputCls} font-mono`} value={f.scope_paths} onChange={(e) => setF({ ...f, scope_paths: e.target.value })} placeholder="src/auth/**, tests/auth" /></L>
        <L label="Tags" className="col-span-1 md:col-span-2"><input className={inputCls} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></L>
        <L label="Depends on" className="col-span-1 md:col-span-1"><input className={inputCls} value={f.depends_on} onChange={(e) => setF({ ...f, depends_on: e.target.value })} /></L>
      </div>
      {EDITABLE.map((k) => (
        <L key={k} label={k}>
          <textarea className={`${textareaCls} ${k === "Verify" ? "font-mono" : ""}`} rows={k === "Goal" || k === "Timebox" || k === "Forbidden" ? 2 : 5}
            value={f.sections[k] ?? ""} onChange={(e) => setF({ ...f, sections: { ...f.sections, [k]: e.target.value } })} />
        </L>
      ))}
      {(dirty || onCancel) && (
        <div className="sticky bottom-0 flex justify-end gap-2 bg-surface py-2">
          <Btn kind="ghost" onClick={() => { setF(init()); onCancel?.(); }}>{onCancel ? "Cancel" : "Discard"}</Btn>
          <Btn kind="primary" disabled={!dirty} onClick={save}>Save changes</Btn>
        </div>
      )}
    </div>
  );
}

function Runs({ runs }: { runs: Run[] }) {
  const [sel, setSel] = useState<string | null>(runs[0]?.id ?? null);
  const detail = useApi<any>(sel ? `/api/runs/${sel}` : null, (e: FEvent) => e.run === sel);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  if (!runs.length) return <Empty>No runs yet.</Empty>;
  const rows = (detail.data?.decisions ?? "").trim().split("\n").slice(1).filter(Boolean).map((l: string) => l.split("\t"));
  const said = (detail.data?.transcript_tail ?? "").split("\n").map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .flatMap((e: any) => e.type === "assistant" ? (e.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text)
      : e.type === "message_end" && e.message?.role === "assistant" ? (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text)
      : e.type === "result" && e.finalText ? [e.finalText] : []).slice(-4);
  const H = ({ children }: { children: React.ReactNode }) => <h4 className="mb-2 text-[12px] font-medium text-fg-muted">{children}</h4>;
  return (
    <div className="grid gap-4 md:grid-cols-[200px_1fr] md:gap-6">
      <ul className="flex gap-1.5 overflow-x-auto pb-1 md:block md:space-y-1 md:overflow-visible md:pb-0">
        {runs.map((r) => (
          <li key={r.id} className="shrink-0 md:shrink">
            <button onClick={() => { setSel(r.id); setFile(null); }} className={`w-44 rounded-lg border border-border px-2.5 py-2 text-left md:w-full md:border-0 transition-colors ${sel === r.id ? "bg-muted" : "hover:bg-hover"}`}>
              <div className="flex items-center gap-2 text-[12.5px] font-medium capitalize"><Dot on={LIVE.includes(r.status)} pulse />{r.role}<span className="ml-auto text-[11px] font-normal text-fg-subtle">{ago(r.started_at)}</span></div>
              <div className="mt-1"><HarnessTag h={r.harness} model={r.model} /></div>
              <div className="mt-1 text-[11px] text-fg-subtle">{r.status} · attempt {r.attempt}</div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 space-y-6">
        {detail.data && (
          <>
            <section>
              <H>Decision log</H>
              {rows.length ? (
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-[12px]">
                    <thead className="bg-muted text-left text-fg-muted">{<tr>{["Phase", "Decision", "Why", "Evidence", "Result"].map((h) => <th key={h} className="px-2.5 py-1.5 font-medium">{h}</th>)}</tr>}</thead>
                    <tbody className="divide-y divide-border">{rows.map((c: string[], i: number) => <tr key={i} className="align-top">{c.slice(1).map((x, j) => <td key={j} className={`px-2.5 py-1.5 ${j === 1 ? "text-fg" : "text-fg-muted"} ${j === 3 ? "font-mono text-[11px]" : ""}`}>{x}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              ) : <p className="text-[12.5px] text-fg-subtle">No decisions logged.</p>}
            </section>
            <section>
              <H>Evidence</H>
              <div className="flex flex-wrap gap-1.5">
                {detail.data.evidence.filter((f: string) => !/(omp|pi)-sessions|transcript|settings|mcp\.json/.test(f)).map((f: string) => (
                  <button key={f} onClick={() => api(`/api/runs/${sel}/file?f=${encodeURIComponent(f)}`, { text: true }).then((text) => setFile({ name: f, text }))}
                    className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${file?.name === f ? "border-fg text-fg" : "border-border text-fg-muted hover:bg-hover"}`}>{f.replace(/\\/g, "/")}</button>
                ))}
              </div>
              {file && <pre className="mt-2 max-h-80 overflow-auto rounded-xl border border-border bg-muted p-3 font-mono text-[11.5px] whitespace-pre-wrap text-fg-muted">{file.text}</pre>}
            </section>
            {said.length > 0 && (
              <section>
                <H>Latest messages</H>
                <div className="space-y-3">{said.map((s: string, i: number) => <div key={i} className="rounded-lg bg-muted px-3 py-2"><Md text={s} /></div>)}</div>
              </section>
            )}
            <p className="font-mono text-[11px] break-all text-fg-subtle">{detail.data.dir}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Diff({ ws, id }: { ws: Workspace; id: string }) {
  const diff = useApi<string>(`/api/ws/${ws.id}/tickets/${id}/diff`, (e: FEvent) => e.ticket === id && /report|gate/.test(e.type), true);
  if (diff.data == null) return <Empty>Loading…</Empty>;
  if (!diff.data) return <Empty>No worktree — not started yet, or already cleaned up.</Empty>;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg">
      <pre className="overflow-x-auto py-2 font-mono text-[12px] leading-[1.6]">
        {diff.data.split("\n").map((l, i) => {
          const s = l.startsWith("+++") || l.startsWith("---") ? { c: "var(--fg)", b: "" } : l.startsWith("+") ? { c: "var(--success)", b: "color-mix(in srgb, var(--success) 10%, transparent)" }
            : l.startsWith("-") ? { c: "var(--danger)", b: "color-mix(in srgb, var(--danger) 10%, transparent)" } : l.startsWith("@@") ? { c: "var(--accent)", b: "" }
            : l.startsWith("diff ") ? { c: "var(--fg)", b: "var(--muted)" } : { c: "var(--fg-muted)", b: "" };
          return <div key={i} className="px-4" style={{ color: s.c, background: s.b || undefined, fontWeight: l.startsWith("diff ") ? 500 : undefined }}>{l || " "}</div>;
        })}
      </pre>
    </div>
  );
}
