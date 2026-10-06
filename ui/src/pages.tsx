import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, useApi, type FEvent, type Harness, type Issue, type Models, type Workspace } from "./api";
import { modelOpts, MultiSelect, Select } from "./select";
import { Badge, Btn, HARNESS_COLOR, inputCls, Md, PageHeader, textareaCls } from "./ui";

const ISSUE_TONE: Record<string, "warning" | "accent" | "neutral" | "success"> = { open: "warning", triaged: "accent", ticketed: "accent", stale: "neutral", closed: "success" };

export function Issues({ ws, openTicket, toast }: { ws: Workspace; openTicket: (id: string) => void; toast: (m: string) => void }) {
  const issues = useApi<Issue[]>(`/api/ws/${ws.id}/issues`, (e: FEvent) => e.ws === ws.id && /issue|store/.test(e.type));
  const [filter, setFilter] = useState("open");
  const [sel, setSel] = useState<string | null>(null);
  const all = issues.data ?? [];
  const list = all.filter((i) => filter === "all" || i.status === filter);
  const cur = all.find((i) => i.id === sel);
  const setStatus = (status: string) => cur && api(`/api/ws/${ws.id}/issues/${cur.id}`, { method: "PATCH", body: { status } }).catch((e) => toast(e.message));
  const n = (f: string) => (f === "all" ? all.length : all.filter((i) => i.status === f).length);

  return (
    <>
      <PageHeader title="Issues" sub={`${all.length} total`}>
        <div role="radiogroup" aria-label="status filter" className="inline-flex max-w-full overflow-x-auto rounded-lg bg-muted p-0.5">
          {["all", "open", "triaged", "ticketed", "stale", "closed"].map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] capitalize transition-colors ${filter === f ? "bg-surface font-medium text-fg shadow-[var(--shadow)]" : "text-fg-muted hover:text-fg"}`}>
              {f}<span className="text-[11px] text-fg-subtle tabular-nums">{n(f)}</span>
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3 md:p-4 lg:grid-cols-[1fr_minmax(380px,44%)]">
        <ul className={`min-h-0 divide-y divide-border overflow-y-auto rounded-2xl border border-border bg-bg ${cur ? "hidden lg:block" : ""}`}>
          {list.map((i) => (
            <li key={i.id}>
              <button onClick={() => setSel(i.id)} className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors ${sel === i.id ? "bg-muted" : "hover:bg-hover"}`}>
                <span className="w-12 shrink-0 font-mono text-[12px] text-fg-subtle">{i.id}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{i.title}</span>
                {i.tickets.length > 0 && <span className="hidden shrink-0 font-mono text-[11px] text-fg-subtle xl:inline">{i.tickets.join(", ")}</span>}
                <span className="hidden w-14 shrink-0 text-[12px] text-fg-subtle capitalize md:inline">{i.kind}</span>
                <Badge tone={ISSUE_TONE[i.status]}>{i.status}</Badge>
              </button>
            </li>
          ))}
          {!list.length && <li className="py-12 text-center text-[13px] text-fg-subtle">No issues</li>}
        </ul>

        <aside className={`min-h-0 overflow-y-auto rounded-2xl border border-border bg-bg p-4 md:p-5 lg:block ${cur ? "" : "hidden"}`}>
          {cur && (
            <button onClick={() => setSel(null)} className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted hover:text-fg lg:hidden">
              <ArrowLeft className="size-3.5" />All issues
            </button>
          )}
          {cur ? (
            <div className="fade-up">
              <div className="flex items-center gap-2 text-[12px] text-fg-subtle"><span className="font-mono">{cur.id}</span><span className="capitalize">· {cur.kind}</span></div>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">{cur.title}</h2>
              <div className="mt-3 inline-flex rounded-lg bg-muted p-0.5">
                {["open", "triaged", "stale", "closed"].map((s) => (
                  <button key={s} onClick={() => setStatus(s)} className={`h-7 rounded-md px-2.5 text-[12.5px] capitalize transition-colors ${cur.status === s ? "bg-surface font-medium text-fg shadow-[var(--shadow)]" : "text-fg-muted hover:text-fg"}`}>{s}</button>
                ))}
              </div>
              {cur.reason && <p className="mt-3 text-[12.5px] text-fg-muted">Reason: {cur.reason}</p>}
              <Md text={cur.body || "_No description._"} className="mt-4" />
              {cur.tickets.length > 0 && (
                <div className="mt-5">
                  <h3 className="mb-2 text-[12px] font-medium text-fg-muted">Tickets</h3>
                  <div className="flex gap-2">{cur.tickets.map((t) => <Btn key={t} onClick={() => openTicket(t)}>{t}</Btn>)}</div>
                </div>
              )}
              <p className="mt-6 rounded-lg bg-muted px-3 py-2 text-[12px] text-fg-muted">
                Triage and ticketing happen in the manager: <code className="font-mono">/factory:issue</code>, <code className="font-mono">/factory:plan --issue {cur.id}</code> or <code className="font-mono">/factory:auto</code>.
              </p>
            </div>
          ) : <p className="pt-10 text-center text-[13px] text-fg-subtle">Select an issue</p>}
        </aside>
      </div>
    </>
  );
}

export function Rules({ ws, toast }: { ws: Workspace; toast: (m: string) => void }) {
  const rules = useApi<string>(`/api/ws/${ws.id}/rules`, (e: FEvent) => e.ws === ws.id && e.type === "rules.changed", true);
  const [text, setText] = useState("");
  useEffect(() => { if (rules.data != null) setText(rules.data); }, [rules.data]);
  const lines = text.split("\n").filter((l) => /^\s*\d+\./.test(l)).length;
  return (
    <>
      <PageHeader title="Rules" sub={`${lines} standing orders · .factory/rules.md`}>
        <Btn kind="primary" disabled={text === rules.data} onClick={() => api(`/api/ws/${ws.id}/rules`, { method: "PUT", body: text }).then(() => { rules.reload(); toast("Rules saved"); }).catch((e) => toast(e.message))}>Save</Btn>
      </PageHeader>
      <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-3 overflow-hidden p-3 md:p-4 lg:grid-cols-[1fr_300px] lg:grid-rows-1">
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="rules.md"
          className={`${textareaCls} min-h-0 resize-none rounded-2xl bg-bg p-4 font-mono text-[13px] leading-7`} />
        <aside className="space-y-2 rounded-2xl border border-border bg-bg p-4 text-[12.5px] leading-relaxed text-fg-muted lg:space-y-3 lg:self-start lg:text-[13px]">
          <p>Standing orders are pasted <strong className="text-fg">verbatim</strong> into every worker and reviewer prompt. Write one numbered constraint per line.</p>
          <p>If you've told workers the same thing twice, it belongs here. <code className="font-mono text-[12px]">/factory:reflect</code> suggests new lines from gate failures.</p>
          <p className="hidden text-fg-subtle lg:block">Keep it under about 25 lines. Long rulebooks get skimmed.</p>
        </aside>
      </div>
    </>
  );
}

const HARNESSES: Harness[] = ["claude", "omp", "commandcode"];

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="grid items-start gap-2 px-4 py-4 md:grid-cols-[220px_1fr] md:gap-6 md:px-5">
    <div><div className="text-[13px] font-medium">{label}</div>{hint && <div className="mt-0.5 text-[12px] leading-snug text-fg-subtle">{hint}</div>}</div>
    <div>{children}</div>
  </div>
);
function Stepper({ value, onChange, min = 0, max = 999, label, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string; suffix?: string }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Number.isFinite(v) ? v : min)));
  const btn = "grid w-7 place-items-center text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-30";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex h-8 overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow)]">
        <button type="button" aria-label={`decrease ${label}`} className={btn} disabled={value <= min} onClick={() => set(value - 1)}>−</button>
        <input aria-label={label} inputMode="numeric" value={value} onChange={(e) => set(parseInt(e.target.value.replace(/\D/g, ""), 10))}
          className="w-10 border-x border-border bg-transparent text-center text-[13px] tabular-nums outline-none" />
        <button type="button" aria-label={`increase ${label}`} className={btn} disabled={value >= max} onClick={() => set(value + 1)}>+</button>
      </span>
      {suffix && <span className="text-[13px] text-fg-muted">{suffix}</span>}
    </span>
  );
}
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0"><div className="mb-1 text-[11.5px] text-fg-subtle">{label}</div>{children}</div>
);
const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="mt-6 first:mt-4">
    <h2 className="mb-2 px-1 text-[13px] font-semibold">{title}</h2>
    <div className="divide-y divide-border rounded-2xl border border-border bg-bg">{children}</div>
  </section>
);
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-primary" : "bg-border-strong"}`}>
      <span className={`absolute top-0.5 size-4 rounded-full bg-surface shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export function Settings({ ws, toast }: { ws: Workspace; toast: (m: string) => void }) {
  const s = useApi<any>(`/api/ws/${ws.id}/settings`, (e: FEvent) => e.ws === ws.id && e.type === "settings.changed");
  const models = useApi<Models>("/api/models", () => false);
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (s.data) setF(structuredClone(s.data)); }, [s.data]);
  if (!f) return (
    <>
      <PageHeader title="Settings" sub=".factory/settings.json" />
      <div className="grid flex-1 place-items-center text-center">
        {s.error ? (
          <div>
            <p className="text-[14px] font-medium">Couldn't load settings</p>
            <p className="mt-1 text-[13px] text-fg-muted">{s.error === "Failed to fetch" ? <>The daemon is offline. Start it with <code className="font-mono">factory up</code>.</> : s.error}</p>
            <div className="mt-3"><Btn onClick={s.reload}>Retry</Btn></div>
          </div>
        ) : <p className="text-[13px] text-fg-subtle">Loading…</p>}
      </div>
    </>
  );
  const dirty = JSON.stringify(f) !== JSON.stringify(s.data);
  const save = () => api(`/api/ws/${ws.id}/settings`, { method: "PUT", body: f }).then(() => { s.reload(); toast("Settings saved"); }).catch((e) => toast(e.message));
  const reviewerFirst = f.reviewer_order.find((h: Harness) => h !== f.default_harness && f.harnesses[h]?.enabled);
  const setH = (h: Harness, patch: object) => setF({ ...f, harnesses: { ...f.harnesses, [h]: { ...f.harnesses[h], ...patch } } });

  return (
    <>
      <PageHeader title="Settings" sub=".factory/settings.json">
        {dirty && <Btn kind="ghost" onClick={() => setF(structuredClone(s.data))}>Discard</Btn>}
        <Btn kind="primary" disabled={!dirty} onClick={save}>Save changes</Btn>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-16 md:px-4">
        <div>
          <Group title="Harnesses">
            {HARNESSES.map((h) => {
              const c = f.harnesses[h];
              return (
                <div key={h} className="space-y-3 px-4 py-4 md:px-5">
                  <div className="flex items-center gap-3">
                    <Switch checked={c.enabled} onChange={(v) => setH(h, { enabled: v })} label={`enable ${h}`} />
                    <span className="size-2 rounded-full" style={{ background: HARNESS_COLOR[h] }} />
                    <span className="text-[13px] font-medium">{h}</span>
                    {f.default_harness === h
                      ? <Badge>default harness</Badge>
                      : <span className="ml-auto"><Btn kind="ghost" disabled={!c.enabled} onClick={() => setF({ ...f, default_harness: h })}>Make default</Btn></span>}
                  </div>
                  <div className={`grid grid-cols-3 gap-3 ${c.enabled ? "" : "pointer-events-none opacity-50"}`}>
                    <Field label="Enabled models">
                      <MultiSelect ariaLabel={`${h} enabled models`} values={c.models}
                        options={(models.data?.[h] ?? []).map((m) => ({ value: m.id, hint: m.hint }))}
                        onChange={(ms) => setF({
                          ...f,
                          harnesses: { ...f.harnesses, [h]: { ...c, models: ms, model: ms.includes(c.model) ? c.model : "" } },
                          reviewer_models: { ...f.reviewer_models, [h]: ms.includes(f.reviewer_models[h]) ? f.reviewer_models[h] : "" },
                        })}>
                        {models.data ? (c.models.length ? `${c.models.length} of ${models.data[h]?.length ?? 0} enabled` : "Default only") : "Loading…"}
                      </MultiSelect>
                    </Field>
                    <Field label="Worker model"><Select ariaLabel={`${h} worker model`} value={c.model} options={modelOpts(c.models)} onChange={(v) => setH(h, { model: v })} /></Field>
                    <Field label="Reviewer model"><Select ariaLabel={`${h} reviewer model`} value={f.reviewer_models[h] ?? ""} options={modelOpts(c.models)} onChange={(v) => setF({ ...f, reviewer_models: { ...f.reviewer_models, [h]: v } })} /></Field>
                  </div>
                </div>
              );
            })}
          </Group>

          <Group title="Workers">
            <Row label="Max workers" hint="Parallel workers across all harnesses."><Stepper label="max workers" min={1} max={16} value={f.max_workers} onChange={(v) => setF({ ...f, max_workers: v })} /></Row>
            <Row label="Reviewer" hint="Auto picks a different model family than the implementer. Pin a harness and model to review every ticket with it.">
              <div className="grid max-w-xl grid-cols-2 gap-3">
                <Field label="Harness">
                  <Select ariaLabel="reviewer harness" value={f.reviewer?.harness ?? "auto"}
                    options={[{ value: "auto", label: "Auto (cross-family)" }, ...HARNESSES.filter((h) => f.harnesses[h]?.enabled).map((h) => ({ value: h, label: h, icon: <span className="size-2 rounded-full" style={{ background: HARNESS_COLOR[h] }} /> }))]}
                    onChange={(v) => setF({ ...f, reviewer: { harness: v, model: "" } })} />
                </Field>
                <Field label="Model">
                  <Select ariaLabel="reviewer model" value={f.reviewer?.model ?? ""} disabled={(f.reviewer?.harness ?? "auto") === "auto"} searchable
                    options={modelOpts(f.harnesses[f.reviewer?.harness]?.models ?? [])} onChange={(v) => setF({ ...f, reviewer: { ...f.reviewer, model: v } })} />
                </Field>
              </div>
            </Row>
            <Row label="Reviewer order" hint="Used by Auto: the first enabled harness that differs from the implementer reviews its work.">
              <div className="flex flex-wrap gap-1.5">
                {f.reviewer_order.map((h: Harness, i: number) => (
                  <button key={h} title={i ? "Move up" : undefined} onClick={() => { if (!i) return; const o = [...f.reviewer_order]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; setF({ ...f, reviewer_order: o }); }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[12.5px] hover:bg-hover">
                    <span className="text-fg-subtle">{i + 1}</span><span className="size-1.5 rounded-full" style={{ background: HARNESS_COLOR[h] }} />{h}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[12px]" style={{ color: reviewerFirst ? "var(--success)" : "var(--warning)" }}>
                {reviewerFirst ? `Work from ${f.default_harness} is reviewed by ${reviewerFirst}, a different model family.` : "Only one harness is enabled, so reviews use a different model on the same harness."}
              </p>
            </Row>
            <Row label="Max gate attempts" hint="After this many attempts the ticket is marked failed."><Stepper label="max gate attempts" min={1} max={6} value={f.max_attempts} onChange={(v) => setF({ ...f, max_attempts: v })} /></Row>
            <Row label="Question timeout" hint="Minutes before an unanswered, reversible question falls back to the worker's default."><Stepper label="question timeout" min={1} max={120} value={f.ask_timeout_min} onChange={(v) => setF({ ...f, ask_timeout_min: v })} suffix="min" /></Row>
            <Row label="Auto mode budget" hint="Limits for /factory:auto. New workers stop starting at 70% of the budget.">
              <div className="flex flex-wrap items-center gap-4">
                <Stepper label="auto budget hours" min={1} max={48} value={f.auto_budget.hours} onChange={(v) => setF({ ...f, auto_budget: { ...f.auto_budget, hours: v } })} suffix="hours" />
                <Stepper label="auto budget tickets" min={1} max={100} value={f.auto_budget.tickets} onChange={(v) => setF({ ...f, auto_budget: { ...f.auto_budget, tickets: v } })} suffix="tickets" />
              </div>
            </Row>
          </Group>

          <Group title="Merging">
            <Row label="Base branch"><input className={`${inputCls} w-60 font-mono`} value={f.base_branch} onChange={(e) => setF({ ...f, base_branch: e.target.value })} /></Row>
            <Row label="Base verify command" hint="Runs on the base branch after every merge. If it fails, the merge is reverted automatically.">
              <input className={`${inputCls} font-mono`} value={f.verify_cmd} placeholder="bun test && bun run typecheck" onChange={(e) => setF({ ...f, verify_cmd: e.target.value })} />
            </Row>
            <Row label="Merge via">
              <div className="inline-flex rounded-lg border border-border p-0.5">
                {[["local", "Local squash"], ["pr", "GitHub PR"]].map(([m, l]) => (
                  <button key={m} onClick={() => setF({ ...f, merge_via: m })} className={`h-7 rounded-md px-3 text-[12.5px] ${f.merge_via === m ? "bg-muted font-medium text-fg" : "text-fg-muted"}`}>{l}</button>
                ))}
              </div>
            </Row>
            <Row label="Auto-merge when green" hint="With this on, /factory:review merges tickets that pass every check without asking you."><Switch checked={f.auto_merge} onChange={(v) => setF({ ...f, auto_merge: v })} label="auto merge" /></Row>
          </Group>

          <Group title="Permissions">
            <Row label="Claude allowlist" hint="One permission rule per line for Claude workers. The guard still blocks push, force, and writes outside scope.">
              <textarea className={`${textareaCls} font-mono text-[12px]`} rows={6} value={f.allowed_tools.join("\n")} onChange={(e) => setF({ ...f, allowed_tools: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} />
            </Row>
          </Group>
        </div>
      </div>
    </>
  );
}
