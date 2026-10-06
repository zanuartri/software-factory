import { marked } from "marked";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Harness } from "./api";

export const HARNESS_COLOR: Record<string, string> = {
  claude: "var(--h-claude)", omp: "var(--h-omp)", commandcode: "var(--h-commandcode)", any: "var(--fg-subtle)",
};

export function HarnessTag({ h, model }: { h: Harness | "any"; model?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
      <span className="size-1.5 rounded-full" style={{ background: HARNESS_COLOR[h] }} />
      {h}
      {model && model !== "default" && <span className="font-mono text-fg-subtle">{model}</span>}
    </span>
  );
}

export function Dot({ on, color = "var(--success)", pulse }: { on: boolean; color?: string; pulse?: boolean }) {
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${pulse && on ? "pulse" : ""}`} style={{ background: on ? color : "var(--border-strong)" }} />;
}

export function Btn({ children, onClick, kind = "secondary", disabled, title, type = "button", size = "sm" }: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "secondary" | "ghost" | "danger"; disabled?: boolean; title?: string; type?: "button" | "submit"; size?: "sm" | "icon";
}) {
  const k = {
    primary: "bg-primary text-primary-fg hover:opacity-90 border-transparent",
    secondary: "bg-surface text-fg border-border hover:bg-hover shadow-[var(--shadow)]",
    ghost: "bg-transparent text-fg-muted border-transparent hover:bg-hover hover:text-fg",
    danger: "bg-surface text-danger border-border hover:bg-hover",
  }[kind];
  return (
    <button type={type} title={title} aria-label={title} disabled={disabled} onClick={onClick}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${size === "icon" ? "w-8" : "px-3"} ${k}`}>
      {children}
    </button>
  );
}

export const inputCls = "h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle outline-none transition focus:border-border-strong focus:ring-4 focus:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)]";
export const textareaCls = "w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none transition focus:border-border-strong focus:ring-4 focus:ring-[color-mix(in_srgb,var(--accent)_15%,transparent)]";

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "accent"; title?: string }) {
  const c = { neutral: "var(--fg-muted)", success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", accent: "var(--accent)" }[tone];
  return (
    <span title={title} className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
      {children}
    </span>
  );
}

export function StatusChip({ t }: { t: { status: string; blocked?: string | null; failed?: string | null } }) {
  if (t.failed) return <Badge tone="danger" title={t.failed}>Failed</Badge>;
  if (t.blocked) return <Badge tone="warning" title={t.blocked}>Blocked</Badge>;
  return null;
}

export const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--fg-subtle)" },
  open: { label: "Open", color: "var(--fg-muted)" },
  in_progress: { label: "In progress", color: "var(--warning)" },
  in_review: { label: "In review", color: "var(--accent)" },
  done: { label: "Done", color: "var(--success)" },
};

/** Linear-style status glyph: ring that fills as work advances */
export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const c = STATUS_META[status]?.color ?? "var(--fg-subtle)";
  const frac = { draft: 0, open: 0, in_progress: 0.5, in_review: 0.75, done: 1 }[status] ?? 0;
  const r = 5, circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={status === "draft" ? "2 2" : undefined} />
      {frac > 0 && frac < 1 && <circle cx="7" cy="7" r={r / 2} fill="none" stroke={c} strokeWidth={r} strokeDasharray={`${circ / 2 * frac} ${circ}`} transform="rotate(-90 7 7)" />}
      {frac === 1 && <><circle cx="7" cy="7" r="6" fill={c} /><path d="M4.5 7.2l1.7 1.6 3.3-3.4" stroke="var(--surface)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>}
    </svg>
  );
}

export const Md = ({ text, className = "" }: { text: string; className?: string }) => (
  <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: marked.parse(text || "", { async: false }) as string }} />
);

export function PageHeader({ title, sub, children, className = "" }: { title: string; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={`flex h-12 shrink-0 items-center gap-3 border-b border-border ${className || "px-4 md:px-6"}`}>
      <h1 className="shrink-0 text-[15px] font-semibold tracking-tight">{title}</h1>
      {sub && <span className="hidden truncate text-[13px] text-fg-subtle md:inline">{sub}</span>}
      <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>
    </header>
  );
}

export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

export function Toast({ msg, onDone }: { msg: string | null; onDone: () => void }) {
  useEffect(() => { if (msg) { const t = setTimeout(onDone, 5000); return () => clearTimeout(t); } }, [msg, onDone]);
  if (!msg) return null;
  return (
    <div role="status" className="fade-up fixed right-5 bottom-5 z-50 max-w-md rounded-xl border border-border bg-surface px-4 py-3 text-[13px] whitespace-pre-wrap shadow-[var(--shadow-lg)]">
      {msg}
    </div>
  );
}

type Theme = "system" | "light" | "dark";
export function ThemeToggle() {
  const read = (): Theme => { try { return (localStorage.getItem("theme") as Theme) || "system"; } catch { return "system"; } };
  const [t, setT] = useState<Theme>(read);
  useEffect(() => {
    if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch {}
  }, [t]);
  const opts: [Theme, typeof Sun][] = [["light", Sun], ["system", Monitor], ["dark", Moon]];
  const i = Math.max(0, opts.findIndex(([v]) => v === t)); // unknown stored value → treat as light
  const Cur = opts[i][1];
  return (
    <>
    {/* icon rail (< lg): one button cycling light → system → dark */}
    <button onClick={() => setT(opts[(i + 1) % 3][0])} aria-label={`theme: ${t}`} title={`Theme: ${t} (click to change)`}
      className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-fg-muted hover:text-fg lg:hidden">
      <Cur className="size-3.5" />
    </button>
    <div role="radiogroup" aria-label="theme" className="hidden rounded-lg border border-border bg-surface p-0.5 lg:inline-flex">
      {opts.map(([v, I]) => (
        <button key={v} role="radio" aria-checked={t === v} aria-label={v} title={v} onClick={() => setT(v)}
          className={`grid size-6 place-items-center rounded-md transition ${t === v ? "bg-muted text-fg" : "text-fg-subtle hover:text-fg"}`}>
          <I className="size-3.5" />
        </button>
      ))}
    </div>
    </>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-12 text-center text-[13px] text-fg-subtle">{children}</p>;
