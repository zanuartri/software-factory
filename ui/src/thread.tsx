import { Bot, CheckCircle2, ChevronRight, Circle, CircleDot, FileText, Globe, ListChecks, Radio, Search, SquareTerminal, Wrench, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Dot, Md } from "./ui";

export type QA = { question: string; header?: string; answer: string | null };
export type AgentInfo = { id: string | null; type: string; desc: string; steps: number; last?: string; done: boolean; report?: string };
export type ToolInfo = {
  id: string; name: string; detail: string; input: string; status: "running" | "background" | "done" | "error";
  result?: string; task?: string; agent?: AgentInfo; todos?: { content: string; status: string }[]; events?: string[];
};
export type Notice = { kind: "task" | "command" | "message"; status?: string; title: string; body?: string };
export type Msg = { id: string; role: "user" | "assistant" | "tool" | "notice"; text: string; ts?: number; images?: number; qa?: QA[]; skipped?: boolean; tool?: ToolInfo; notice?: Notice };
/** A user message. `@<path>` mentions of uploaded images render as thumbnails; `images` counts images pasted in the terminal. */
export function UserBubble({ text, images = 0, queued, local = [] }: { text: string; images?: number; queued?: boolean; local?: string[] }) {
  const urls: string[] = [];
  const rest = text.replace(/@(?:"([^"]+)"|(\S+))/g, (m, a, b) => {
    const p = (a ?? b) as string, seg = p.replace(/\\/g, "/").split("/");
    if (seg.at(-3) !== "uploads") return m;
    urls.push(`/api/uploads/${seg.at(-2)}/${seg.at(-1)}`);
    return "";
  }).trim();
  const imgs = local.length ? local : urls;
  return (
    <div className={`ml-auto max-w-[85%] ${queued ? "opacity-70" : ""}`}>
      <div className="rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] break-words whitespace-pre-wrap text-on-bubble">
        {imgs.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1.5">{imgs.map((u, i) => <a key={i} href={u} target="_blank" rel="noreferrer"><img src={u} alt="attached" className="aspect-[4/3] w-40 max-w-full rounded-lg object-cover" /></a>)}</div>}
        {images > 0 && !imgs.length && <div className="mb-1 text-[12px] opacity-80">{images} image{images > 1 ? "s" : ""} attached</div>}
        {rest}
      </div>
      {queued && <div className="mt-0.5 mr-1 text-right text-[10.5px] text-fg-subtle">Queued — delivered at Claude's next pause</div>}
    </div>
  );
}

export type Activity = { running: { name: string; detail: string } | null; background: number };

const ICON: Record<string, typeof Wrench> = { Bash: SquareTerminal, PowerShell: SquareTerminal, Read: FileText, Write: FileText, Edit: FileText, NotebookEdit: FileText, Grep: Search, Glob: Search, ToolSearch: Search, WebFetch: Globe, WebSearch: Globe, Monitor: Radio };

function StatusMark({ s }: { s: ToolInfo["status"] }) {
  if (s === "running") return <span className="flex items-center gap-1 text-[11px] text-fg-subtle"><Dot on pulse color="var(--accent)" />running</span>;
  if (s === "background") return <span className="flex items-center gap-1 text-[11px] text-accent"><Dot on pulse color="var(--accent)" />background</span>;
  if (s === "error") return <XCircle className="size-3.5 text-danger" aria-label="failed" />;
  return <CheckCircle2 className="size-3.5 text-fg-subtle" aria-label="done" />;
}

const Pre = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <div className="mb-0.5 text-[10.5px] font-medium tracking-wide text-fg-subtle uppercase">{label}</div>
    <pre className="max-h-48 overflow-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap text-fg-muted">{children}</pre>
  </div>
);

/** One tool call: name, what it ran on, and a live state. Click for the input and the result. */
export function ToolRow({ t }: { t: ToolInfo }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[t.name] ?? Wrench;
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-1.5 rounded-md py-0.5 text-left font-mono text-[11px] text-fg-subtle hover:text-fg-muted">
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon className="size-3 shrink-0" />
        <span className="shrink-0 font-medium text-fg-muted">{t.name}</span>
        <span className="min-w-0 flex-1 truncate">{t.detail}{t.events?.length ? ` · ${t.events.at(-1)}` : ""}</span>
        {t.events?.length ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px]">{t.events.length}</span> : null}
        <StatusMark s={t.status} />
      </button>
      {open && (
        <div className="mt-1 mb-1.5 ml-4 space-y-1.5">
          {t.input && t.input !== "{}" && <Pre label="Input">{t.input}</Pre>}
          {t.events?.length ? <Pre label={`Events (${t.events.length})`}>{t.events.join("\n")}</Pre> : null}
          {t.result ? <Pre label={t.status === "error" ? "Error" : "Result"}>{t.result}</Pre> : <p className="text-[11px] text-fg-subtle">{t.status === "running" ? "Waiting for the result…" : "No output."}</p>}
        </div>
      )}
    </div>
  );
}

/** A subagent: what it was asked, how far along it is, and its report once it hands back. */
export function AgentCard({ t }: { t: ToolInfo }) {
  const a = t.agent!;
  const [open, setOpen] = useState(false);
  const live = t.status === "running" || t.status === "background";
  return (
    <div className="rounded-xl border border-border bg-bg">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Bot className="size-3.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{a.desc || "Subagent"}</span>
          <span className="block truncate text-[11px] text-fg-subtle">{a.type}{a.steps ? ` · ${a.steps} step${a.steps > 1 ? "s" : ""}` : ""}{live && a.last ? ` · ${a.last}` : ""}</span>
        </span>
        <StatusMark s={t.status} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          {a.report ? <Md text={a.report} className="text-[12.5px]" copyCode /> : <p className="text-[12px] text-fg-subtle">{live ? "Still working — the report appears here when it hands back." : "No report."}</p>}
          {t.input && <details className="text-[11px] text-fg-subtle"><summary className="cursor-pointer">Brief</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{t.input}</pre></details>}
        </div>
      )}
    </div>
  );
}

/** TodoWrite: the checklist, in full only for the latest update (older ones fold into one line). */
export function TodoCard({ t, latest }: { t: ToolInfo; latest: boolean }) {
  const todos = t.todos ?? [];
  const done = todos.filter((x) => x.status === "completed").length;
  if (!latest) return <div className="flex items-center gap-1.5 font-mono text-[11px] text-fg-subtle"><ListChecks className="size-3 shrink-0" />Todos updated · {done}/{todos.length} done</div>;
  return (
    <div className="rounded-xl border border-border bg-bg px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg-muted"><ListChecks className="size-3.5" />Todos <span className="font-normal text-fg-subtle">{done}/{todos.length}</span></div>
      <ul className="space-y-1">
        {todos.map((x, i) => (
          <li key={i} className={`flex items-start gap-2 text-[12.5px] leading-snug ${x.status === "completed" ? "text-fg-subtle line-through" : ""}`}>
            {x.status === "completed" ? <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" /> : x.status === "in_progress" ? <CircleDot className="mt-px size-3.5 shrink-0 text-accent" /> : <Circle className="mt-px size-3.5 shrink-0 text-fg-subtle" />}
            {x.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Something that happened without you asking: a background task finished, a message arrived, a local command printed. */
export function NoticeRow({ n }: { n: Notice }) {
  const [open, setOpen] = useState(false);
  const bad = n.status && n.status !== "completed";
  const Icon = n.kind === "task" ? (bad ? XCircle : CheckCircle2) : n.kind === "command" ? SquareTerminal : Radio;
  return (
    <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
      <button type="button" disabled={!n.body} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-[12px] text-fg-muted disabled:cursor-default">
        <Icon className={`size-3.5 shrink-0 ${bad ? "text-danger" : n.kind === "task" ? "text-success" : ""}`} />
        <span className="min-w-0 flex-1 truncate">{n.title}</span>
        {n.body && <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />}
      </button>
      {open && n.body && <pre className="mt-1.5 max-h-48 overflow-auto font-mono text-[11px] leading-snug whitespace-pre-wrap text-fg-subtle">{n.body}</pre>}
    </div>
  );
}
