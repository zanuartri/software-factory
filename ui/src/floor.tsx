import { ArrowUp, Pause, Play, Skull, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ago, api, LIVE, useApi, useLive, type Ask, type FEvent, type Run, type Ticket, type Workspace } from "./api";
import { Checkbox } from "./select";
import { Badge, Btn, Dot, HarnessTag, inputCls, PageHeader, STATUS_META, StatusChip, StatusIcon, useTick } from "./ui";

const PHASES = ["plan", "implement", "test", "review", "gate"] as const;
const phaseIdx = (p: string | null) => ({ plan: 0, implement: 1, fix: 1, test: 2, review: 3, "wrap-up": 3, gate: 4 } as Record<string, number>)[p ?? "plan"] ?? 0;

type Tone = "success" | "danger" | "warning" | "accent" | "muted" | "subtle";
export function describe(e: FEvent): { text: string; tone: Tone } {
  const d = e.data ?? {};
  const t = e.ticket ?? "";
  switch (e.type) {
    case "run.started": return { text: `${t} started on ${d.harness}${d.model ? ` · ${d.model}` : ""} (attempt ${d.attempt})`, tone: "accent" };
    case "run.report": return { text: `${t} · ${d.phase} — ${d.summary}`, tone: "muted" };
    case "run.tool": return { text: `${t} · ${d.name}`, tone: "subtle" };
    case "run.decision": return { text: `${t} decided: ${d.decision}`, tone: "muted" };
    case "ask": return { text: `${t} asked: ${d.question}`, tone: "warning" };
    case "ask.answered": return { text: `#${d.id} answered by ${d.by}: ${d.answer}`, tone: "muted" };
    case "ask.timeout": return { text: `#${d.id} timed out, took default: ${d.default}`, tone: "warning" };
    case "gate.started": return { text: `${t} entered the gate (attempt ${d.attempt})`, tone: "accent" };
    case "gate.verify": return { text: `${t} verify ${d.ok ? "passed" : "failed"}`, tone: d.ok ? "success" : "danger" };
    case "review.started": return { text: `${t} review by ${d.harness}${d.model ? ` · ${d.model}` : ""}`, tone: "accent" };
    case "review.verdict": return { text: `${t} reviewer ${d.harness}: ${d.verdict}`, tone: d.verdict === "PASS" ? "success" : "danger" };
    case "gate.passed": return { text: `${t} passed the gate → in review`, tone: "success" };
    case "gate.failed": return { text: `${t} gate failed (attempt ${d.attempt})`, tone: "danger" };
    case "ticket.blocked": return { text: `${t} blocked: ${d.reason}`, tone: "warning" };
    case "ticket.failed": return { text: `${t} failed: ${d.reason}`, tone: "danger" };
    case "guard.blocked": return { text: `${t} guard blocked ${d.tool}: ${String(d.reason).replace("factory guard: ", "")}`, tone: "warning" };
    case "run.steer": return { text: `${t} steered: ${d.text}`, tone: "muted" };
    case "run.abort": return { text: `${t} interrupted${d.text ? `: ${d.text}` : ""}`, tone: "danger" };
    case "run.stuck": return { text: `${t} no heartbeat for ${d.minutes}m`, tone: "warning" };
    case "run.died": return { text: `${t} process exited`, tone: "danger" };
    case "run.timebox": return { text: `${t} timebox expired`, tone: "warning" };
    case "plan.started": return { text: `Run started (${d.mode})`, tone: "accent" };
    case "plan.drained": return { text: `Run finished — in review: ${d.in_review?.join(", ") || "none"}`, tone: "success" };
    case "merge.done": return { text: `${t} merged ${d.sha?.slice(0, 7)}`, tone: "success" };
    case "merge.reverted": return { text: `${t} auto-reverted after base verify failed`, tone: "danger" };
    case "merge.conflict": return { text: `${t} conflicts in ${d.files?.join(", ")}`, tone: "warning" };
    default: return { text: `${e.type} ${t}`, tone: "subtle" };
  }
}
const TONE: Record<Tone, string> = { success: "var(--success)", danger: "var(--danger)", warning: "var(--warning)", accent: "var(--accent)", muted: "var(--fg-muted)", subtle: "var(--border-strong)" };

export function Floor({ ws, openTicket, openBoard, toast }: { ws: Workspace; openTicket: (id: string) => void; openBoard: () => void; toast: (m: string) => void }) {
  const mine = (e: FEvent) => e.ws === ws.id;
  const runs = useApi<Run[]>(`/api/ws/${ws.id}/runs`, (e) => mine(e) && /^(run|gate|review|ticket|plan|merge)\./.test(e.type) && e.type !== "run.text");
  const tickets = useApi<Ticket[]>(`/api/ws/${ws.id}/tickets`, (e) => mine(e) && /ticket|store|gate|merge/.test(e.type));
  const asks = useApi<Ask[]>(`/api/ws/${ws.id}/asks`, (e) => mine(e) && e.type.startsWith("ask"));
  const info = useApi<Workspace>(`/api/ws/${ws.id}`, (e) => mine(e) && /plan|settings/.test(e.type));
  const [feed, setFeed] = useState<FEvent[]>([]);
  const [showTools, setShowTools] = useState(false);
  useEffect(() => { api<FEvent[]>(`/api/ws/${ws.id}/events?limit=200`).then(setFeed); }, [ws.id]);
  useLive((e) => mine(e) && setFeed((f) => [...f.slice(-399), e]));
  useTick();

  const byId = useMemo(() => new Map((tickets.data ?? []).map((t) => [t.id, t])), [tickets.data]);
  const live = (runs.data ?? []).filter((r) => LIVE.includes(r.status));
  const workers = live.filter((r) => r.role === "worker");
  const reviewers = live.filter((r) => r.role === "reviewer");
  const slots = Math.max(ws.settings?.max_workers ?? 3, workers.length);
  const pending = (asks.data ?? []).filter((a) => a.answer == null);
  const count = (s: Ticket["status"]) => (tickets.data ?? []).filter((t) => t.status === s).length;
  const attention = (tickets.data ?? []).filter((t) => t.blocked || t.failed || t.status === "in_review");
  const plan = info.data?.plan;
  const visibleFeed = feed.filter((e) => e.type !== "run.text" && e.type !== "store.changed" && (showTools || e.type !== "run.tool")).slice(-150).reverse();

  return (
    <>
      <PageHeader title="Workers" sub={`${workers.length} of ${ws.settings?.max_workers ?? 3} slots busy`}>
        {plan?.active && <span className="mr-1 hidden text-[12px] text-fg-muted md:inline">{plan.started} spawned · ends {new Date(plan.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        {plan?.active
          ? <Btn onClick={() => api(`/api/ws/${ws.id}/stop`, { body: {} }).catch((e) => toast(e.message))}><Square className="size-3.5" />Stop run</Btn>
          : <Btn kind="primary" onClick={() => api(`/api/ws/${ws.id}/run`, { body: {} }).catch((e) => toast(e.message))}><Play className="size-3.5" />Run<span className="hidden md:inline"> open tickets</span></Btn>}
      </PageHeader>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[1fr_360px] xl:overflow-hidden">
        <div className="space-y-6 px-4 py-4 md:space-y-8 md:px-6 md:py-6 xl:min-h-0 xl:overflow-y-auto">
          <button onClick={openBoard} title="Open board" className="-mx-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-1.5 py-1 text-[13px] text-fg-muted transition-colors hover:bg-hover">
            {(["draft", "open", "in_progress", "in_review", "done"] as const).filter((s) => count(s) > 0).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <StatusIcon status={s} size={12} /><span className="font-medium text-fg tabular-nums">{count(s)}</span>{STATUS_META[s].label.toLowerCase()}
              </span>
            ))}
            {!(tickets.data ?? []).length && <span>No tickets yet — plan some with /factory:plan</span>}
          </button>

          {/* workers */}
          <section>
            <h2 className="mb-3 text-[13px] font-medium text-fg-muted">Active workers</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {workers.map((r) => (
                <WorkerCard key={r.id} run={r} ticket={byId.get(r.ticket)} reviewer={reviewers.find((x) => x.parent === r.id)} tools={feed.filter((e) => e.run === r.id && e.type === "run.tool").slice(-3)} openTicket={openTicket} toast={toast} />
              ))}
              {slots > workers.length && (
                <div className="col-span-full flex h-11 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border text-[12.5px] text-fg-subtle">
                  {slots - workers.length} idle slot{slots - workers.length > 1 ? "s" : ""}{!workers.length && " — run open tickets to start workers"}
                </div>
              )}
            </div>
          </section>

          {attention.length > 0 && (
            <section>
              <h2 className="mb-3 text-[13px] font-medium text-fg-muted">Needs attention</h2>
              <div className="card divide-y divide-border overflow-hidden">
                {attention.map((t) => (
                  <button key={t.id} onClick={() => openTicket(t.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover">
                    <StatusIcon status={t.status} />
                    <span className="w-12 font-mono text-[12px] text-fg-subtle">{t.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
                    {(t.blocked || t.failed) && <span className="hidden max-w-[40%] truncate text-[12px] text-fg-subtle md:inline">{t.blocked ?? t.failed}</span>}
                    {t.blocked || t.failed ? <StatusChip t={t} /> : <Badge tone="accent">Review</Badge>}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* right column */}
        <aside className="flex flex-col border-t xl:min-h-0 border-border bg-bg xl:border-t-0 xl:border-l">
          {pending.length > 0 && (
            <section className="border-b border-border p-4 xl:max-h-[50%] xl:min-h-0 xl:overflow-y-auto">
              <h2 className="mb-3 flex items-center gap-2 text-[13px] font-medium">Questions <Badge tone="warning">{pending.length}</Badge></h2>
              <div className="space-y-3">{pending.map((a) => <AskCard key={a.id} a={a} toast={toast} />)}</div>
            </section>
          )}
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center px-4 pt-4 pb-2">
              <h2 className="text-[13px] font-medium">Activity</h2>
              <span className="ml-auto"><Checkbox checked={showTools} onChange={setShowTools} label="Tool calls" /></span>
            </div>
            <ol className="max-h-[480px] min-h-0 flex-1 overflow-y-auto px-4 pb-4 xl:max-h-none">
              {visibleFeed.map((e) => {
                const d = describe(e);
                return (
                  <li key={e.id} className="fade-up relative flex gap-3 py-1.5 pl-4 before:absolute before:top-0 before:bottom-0 before:left-[3px] before:w-px before:bg-border">
                    <span className="absolute top-[11px] left-0 size-[7px] rounded-full ring-2 ring-bg" style={{ background: TONE[d.tone] }} />
                    <button onClick={() => e.ticket && openTicket(e.ticket)} className={`min-w-0 flex-1 text-left text-[12.5px] leading-snug ${d.tone === "subtle" ? "text-fg-subtle" : "text-fg-muted hover:text-fg"}`}>{d.text}</button>
                    <time className="shrink-0 pt-px font-mono text-[11px] text-fg-subtle">{new Date(e.ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}</time>
                  </li>
                );
              })}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}

function WorkerCard({ run, ticket, reviewer, tools, openTicket, toast }: { run: Run; ticket?: Ticket; reviewer?: Run; tools: FEvent[]; openTicket: (id: string) => void; toast: (m: string) => void }) {
  const [msg, setMsg] = useState("");
  const idx = run.status === "gating" ? 4 : phaseIdx(run.phase);
  const running = run.status === "running" || run.status === "starting" || run.status === "gating";
  const act = (p: Promise<unknown>) => p.catch((e) => toast(e.message));
  const send = (abort: boolean) => {
    if (!msg.trim()) return;
    act(api(`/api/runs/${run.id}/${abort ? "abort" : "steer"}`, { body: { text: msg } })).then(() => setMsg(""));
  };
  return (
    <article className="card fade-up flex flex-col p-3.5 md:p-4">
      <div className="flex items-start gap-3">
        <button onClick={() => openTicket(run.ticket)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2 text-[12px] text-fg-subtle"><span className="font-mono">{run.ticket}</span>{ticket && <StatusChip t={ticket} />}</div>
          <div className="mt-0.5 truncate text-[14px] font-medium hover:underline">{ticket?.title ?? "…"}</div>
        </button>
        <div className="flex items-center gap-1.5 text-[12px] text-fg-muted"><Dot on={running} pulse />{run.status}</div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-fg-subtle">
        <HarnessTag h={run.harness} model={run.model} />
        <span>attempt {run.attempt}</span><span>·</span><span>{ago(run.started_at)}</span>
        {run.tokens > 0 && <><span>·</span><span>{(run.tokens / 1000).toFixed(1)}k tokens</span></>}
      </div>

      {/* phase progress */}
      <div className="mt-4">
        <div className="flex gap-1">
          {PHASES.map((p, i) => (
            <div key={p} className={`h-1 flex-1 rounded-full ${i === idx && running ? "pulse" : ""}`}
              style={{ background: i < idx ? "var(--success)" : i === idx ? "var(--accent)" : "var(--muted)" }} />
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-fg-subtle">
          {PHASES.map((p, i) => <span key={p} className={i === idx ? "font-medium text-fg" : ""}>{p}</span>)}
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.6em] text-[13px] leading-snug text-fg-muted">{run.summary ?? <span className="text-fg-subtle">Starting…</span>}</p>
      <div className="mt-1 h-[3.6em] overflow-hidden font-mono text-[11px] leading-[1.2em] text-fg-subtle">
        {tools.map((t) => <div key={t.id} className="truncate"><Zap className="mr-1 inline size-2.5" />{t.data.name}</div>)}
      </div>

      {reviewer && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-[12px]">
          <span className="text-fg-muted">Reviewing</span><HarnessTag h={reviewer.harness} model={reviewer.model} />
          <span className="ml-auto truncate text-fg-subtle">{reviewer.status}</span>
        </div>
      )}

      <div className="mt-3 flex gap-1.5 border-t border-border pt-3">
        <div className="relative min-w-0 flex-1">
          <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(e.shiftKey)}
            placeholder="Message worker…" aria-label={`message ${run.ticket}`} className={`${inputCls} pr-8`} />
          <button onClick={() => send(false)} aria-label="send" title="Send (Enter) · interrupt (Shift+Enter)" className="absolute top-1 right-1 grid size-6 place-items-center rounded-md bg-primary text-primary-fg disabled:opacity-30" disabled={!msg.trim()}>
            <ArrowUp className="size-3.5" />
          </button>
        </div>
        <Btn size="icon" kind="ghost" title="Pause" onClick={() => act(api(`/api/runs/${run.id}/abort`, { body: {} }))}><Pause className="size-3.5" /></Btn>
        <Btn size="icon" kind="ghost" title="Kill" onClick={() => confirm(`Stop ${run.ticket}'s worker?`) && act(api(`/api/runs/${run.id}/kill`, { body: {} }))}><Skull className="size-3.5" /></Btn>
      </div>
    </article>
  );
}

function AskCard({ a, toast }: { a: Ask; toast: (m: string) => void }) {
  const [custom, setCustom] = useState("");
  const options: string[] = JSON.parse(a.options || "[]");
  const answer = (v: string) => api(`/api/asks/${a.id}/answer`, { body: { answer: v, by: "human (ui)" } }).catch((e) => toast(e.message));
  useTick(5000);
  const left = Math.max(0, Math.round((a.deadline - Date.now()) / 60000));
  return (
    <div className="card fade-up p-3">
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-fg-subtle">
        <span className="font-mono">{a.ticket}</span>
        {a.irreversible ? <Badge tone="danger">Irreversible</Badge> : <span>default in {left}m</span>}
      </div>
      <p className="mb-2.5 text-[13px] leading-snug">{a.question}</p>
      <div className="flex flex-col gap-1">
        {options.map((o) => (
          <button key={o} onClick={() => answer(o)} className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover">
            {o}{o === a.default_answer && <span className="text-[11px] text-fg-subtle">default</span>}
          </button>
        ))}
      </div>
      <form className="mt-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) answer(custom); }}>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or type an answer…" aria-label="custom answer" className={inputCls} />
      </form>
    </div>
  );
}
