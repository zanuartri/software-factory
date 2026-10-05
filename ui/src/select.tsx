// Custom Select / MultiSelect / Checkbox — no native form controls anywhere in the UI.
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type Opt = { value: string; label?: ReactNode; hint?: string; icon?: ReactNode; search?: string };

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[12.5px] text-fg-muted disabled:opacity-40">
      <span className={`grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors ${checked ? "border-primary bg-primary text-primary-fg" : "border-border-strong bg-surface"}`}>
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      {label}
    </button>
  );
}

/** Floating panel anchored to a trigger; portaled so drawers/overflow never clip it. Flips up when there's no room below. */
function usePopover(open: boolean, close: () => void) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const below = innerHeight - r.bottom - 8, above = r.top - 8;
    const up = below < 240 && above > below;
    const width = Math.min(Math.max(r.width, 240), innerWidth - 16);
    setPos({ left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), width, maxH: Math.min(360, up ? above : below), ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(); };
    const onScroll = (e: Event) => { if (!panel.current?.contains(e.target as Node)) close(); };
    addEventListener("pointerdown", onDown); addEventListener("scroll", onScroll, true); addEventListener("resize", close);
    return () => { removeEventListener("pointerdown", onDown); removeEventListener("scroll", onScroll, true); removeEventListener("resize", close); };
  }, [open, close]);
  return { trigger, panel, pos };
}

const triggerCls = {
  input: "h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-fg shadow-[var(--shadow)] hover:border-border-strong",
  ghost: "h-8 rounded-lg border border-border px-2.5 text-[13px] text-fg hover:bg-hover",
  bare: "rounded-lg px-2 py-1.5 text-left hover:bg-hover",
};

function List({ options, isOn, onPick, searchable, multi, activeInit, onClose, footer }: {
  options: Opt[]; isOn: (v: string) => boolean; onPick: (v: string) => void; searchable: boolean; multi?: boolean; activeInit: number; onClose: () => void; footer?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(Math.max(0, activeInit));
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => `${o.value} ${o.search ?? ""} ${typeof o.label === "string" ? o.label : ""} ${o.hint ?? ""}`.toLowerCase().includes(n)) : options;
  }, [q, options]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) onPick(shown[active].value); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); onClose(); }
  };
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { focusRef.current?.focus(); }, []);
  return (
    <div onKeyDown={onKey} className="flex min-h-0 flex-col">
      {searchable && (
        <div className="flex items-center gap-2 border-b border-border px-2.5">
          <Search className="size-3.5 text-fg-subtle" />
          <input ref={(el) => { focusRef.current = el; }} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search…" aria-label="search options"
            aria-controls={id} aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
            className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle focus-visible:outline-none" />
        </div>
      )}
      <div ref={(el) => { listRef.current = el; if (!searchable) focusRef.current = el; }} id={id} role="listbox" aria-multiselectable={multi || undefined} tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto p-1 outline-none">
        {shown.map((o, i) => {
          const on = isOn(o.value);
          return (
            <div key={o.value} id={`${id}-${i}`} data-i={i} role="option" aria-selected={on} onPointerMove={() => setActive(i)} onClick={() => onPick(o.value)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${i === active ? "bg-hover" : ""}`}>
              {multi
                ? <span className={`grid size-4 shrink-0 place-items-center rounded-[5px] border ${on ? "border-primary bg-primary text-primary-fg" : "border-border-strong"}`}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                : o.icon}
              <span className="min-w-0 flex-1 truncate">{o.label ?? o.value}</span>
              {o.hint && <span className="max-w-[45%] shrink-0 truncate text-[11.5px] text-fg-subtle">{o.hint}</span>}
              {!multi && on && <Check className="size-3.5 shrink-0 text-fg" />}
            </div>
          );
        })}
        {!shown.length && <p className="px-2 py-3 text-center text-[12.5px] text-fg-subtle">No matches</p>}
      </div>
      {footer}
    </div>
  );
}

export function Select({ value, onChange, options, placeholder = "Select…", ariaLabel, variant = "input", renderValue, searchable, className = "", chevronClass = "", disabled }: {
  value: string; onChange: (v: string) => void; options: Opt[]; placeholder?: string; ariaLabel: string;
  variant?: keyof typeof triggerCls; renderValue?: (o: Opt | undefined) => ReactNode; searchable?: boolean; className?: string; chevronClass?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); pop.trigger.current?.focus(); };
  const pop = usePopover(open, () => setOpen(false));
  const cur = options.find((o) => o.value === value);
  return (
    <>
      <button ref={pop.trigger} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
        className={`inline-flex disabled:pointer-events-none disabled:opacity-50 min-w-0 items-center gap-2 transition-colors ${triggerCls[variant]} ${className}`}>
        {renderValue ? renderValue(cur) : <>
          {cur?.icon}
          <span className={`min-w-0 flex-1 truncate text-left ${cur ? "" : "text-fg-subtle"}`}>{cur ? cur.label ?? cur.value : placeholder}</span>
        </>}
        <ChevronDown className={`size-3.5 shrink-0 text-fg-subtle ${chevronClass}`} />
      </button>
      {open && pop.pos && createPortal(
        <div ref={pop.panel} className="fade-up fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-lg)]"
          style={{ left: pop.pos.left, top: pop.pos.top, bottom: pop.pos.bottom, width: pop.pos.width, maxHeight: pop.pos.maxH }}>
          <List options={options} isOn={(v) => v === value} searchable={searchable ?? options.length > 8}
            activeInit={options.findIndex((o) => o.value === value)} onClose={close}
            onPick={(v) => { onChange(v); close(); }} />
        </div>, document.body)}
    </>
  );
}

export function MultiSelect({ values, onChange, options, ariaLabel, children }: {
  values: string[]; onChange: (v: string[]) => void; options: Opt[]; ariaLabel: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pop = usePopover(open, () => setOpen(false));
  const set = new Set(values);
  const toggle = (v: string) => onChange(set.has(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <>
      <button ref={pop.trigger} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 ${triggerCls.input}`}>
        <span className="min-w-0 flex-1 truncate text-left">{children}</span>
        <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
      </button>
      {open && pop.pos && createPortal(
        <div ref={pop.panel} className="fade-up fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-lg)]"
          style={{ left: Math.max(8, Math.min(pop.pos.left, innerWidth - Math.min(Math.max(pop.pos.width, 320), innerWidth - 16) - 8)), top: pop.pos.top, bottom: pop.pos.bottom, width: Math.min(Math.max(pop.pos.width, 320), innerWidth - 16), maxHeight: pop.pos.maxH }}>
          <List multi options={options} isOn={(v) => set.has(v)} searchable activeInit={0} onClose={() => { setOpen(false); pop.trigger.current?.focus(); }} onPick={toggle}
            footer={
              <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[12px] text-fg-subtle">
                <span>{values.length} enabled</span>
                <span className="flex gap-3">
                  <button type="button" className="hover:text-fg" onClick={() => onChange(options.map((o) => o.value))}>All</button>
                  <button type="button" className="hover:text-fg" onClick={() => onChange([])}>None</button>
                </span>
              </div>
            } />
        </div>, document.body)}
    </>
  );
}

/** Model picker options: the harness default first, then only the models enabled in settings. */
export const modelOpts = (enabled: string[], defaultLabel = "Harness default", defaultValue = "", defaultHint = "CLI's own default"): Opt[] =>
  [{ value: defaultValue, label: defaultLabel, hint: defaultHint }, ...enabled.map((id) => ({ value: id }))];
