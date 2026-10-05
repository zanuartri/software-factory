import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CornerDownLeft, Square, SquareCheck, X } from "lucide-react";
import { useState } from "react";

export type PromptOption = { n: number | null; label: string; desc?: string; checked: boolean | null; chosen: boolean; focused: boolean; input: boolean };
export type PromptTab = { label: string; done: boolean; submit: boolean; active: boolean };
export type Prompt = { title: string; context: string; tabs: PromptTab[]; options: PromptOption[]; multi: boolean; footer: string; amend: boolean; screen: string };
export type Answer = { keys?: string[]; text?: string; enter?: boolean };

const rep = (k: string, n: number) => Array.from({ length: Math.abs(n) }, () => k);

/** What Claude Code is waiting on, drawn from the same choices the terminal shows. Every control sends the key presses a person would type. */
export function AskCard({ prompt, send, busy }: { prompt: Prompt | { raw: string }; send: (a: Answer) => void; busy: boolean }) {
  const [typing, setTyping] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [amend, setAmend] = useState(false);
  const [note, setNote] = useState("");
  if ("raw" in prompt) return <RawCard screen={prompt.raw} send={send} busy={busy} />;

  const focused = Math.max(0, prompt.options.findIndex((o) => o.focused));
  const pick = (i: number) => {
    const o = prompt.options[i];
    if (o.input) { setTyping(i); setText(""); return; }
    if (o.n != null) return send({ keys: [String(o.n)] });
    send({ keys: [...rep(i > focused ? "down" : "up", i - focused), "enter"] }); // unnumbered menu (folder trust): move the cursor, then Enter
  };
  const submitText = (o: PromptOption) => { send({ keys: o.n != null ? [String(o.n)] : [], text, enter: true }); setTyping(null); setText(""); };
  const tabIdx = prompt.tabs.findIndex((t) => t.active);
  const goTab = (j: number) => tabIdx >= 0 && j !== tabIdx && send({ keys: rep(j > tabIdx ? "right" : "left", j - tabIdx) });
  const btn = "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors disabled:opacity-40";

  return (
    <div role="group" aria-label="Claude is waiting for your answer" className="fade-up rounded-2xl border border-border-strong bg-surface p-3.5 shadow-[var(--shadow)]">
      {prompt.tabs.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1" role="tablist">
          {prompt.tabs.map((t, j) => (
            <button key={j} role="tab" aria-selected={t.active} disabled={busy || tabIdx < 0} onClick={() => goTab(j)}
              className={`inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] transition-colors ${t.active ? "bg-primary text-primary-fg" : "bg-muted text-fg-muted hover:text-fg"}`}>
              {t.done && <Check className="size-3" strokeWidth={2.5} />}{t.submit ? "Review" : t.label}
            </button>
          ))}
        </div>
      )}
      {prompt.context && <pre className="mb-3 max-h-48 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-muted">{prompt.context}</pre>}
      {prompt.title && <p className="mb-2.5 text-[13.5px] leading-snug font-medium">{prompt.title}</p>}

      <ul className="space-y-1.5">
        {prompt.options.map((o, i) => (
          <li key={i}>
            {typing === i ? (
              <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) submitText(o); }} className="flex items-center gap-1.5 rounded-xl border border-border-strong bg-bg py-1 pr-1 pl-3">
                <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setTyping(null)} placeholder={o.label.replace(/\.$/, "") + "…"} aria-label={o.label}
                  className="no-ring h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
                <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg disabled:opacity-25"><CornerDownLeft className="size-3.5" /></button>
              </form>
            ) : (
              <button type="button" disabled={busy} onClick={() => pick(i)}
                className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-hover disabled:opacity-60 ${o.chosen || o.checked ? "border-border-strong bg-muted" : "border-border"}`}>
                {prompt.multi && o.checked !== null
                  ? (o.checked ? <SquareCheck className="mt-px size-4 shrink-0 text-primary" /> : <Square className="mt-px size-4 shrink-0 text-fg-subtle" />)
                  : <span className="mt-px grid size-[18px] shrink-0 place-items-center rounded-md bg-muted font-mono text-[11px] text-fg-muted">{o.n ?? "•"}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug">{o.label}</span>
                  {o.desc && <span className="mt-0.5 block text-[12px] leading-snug text-fg-subtle">{o.desc}</span>}
                </span>
                {o.chosen && <Check className="mt-px size-4 shrink-0 text-success" />}
              </button>
            )}
          </li>
        ))}
      </ul>

      {amend && (
        <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) { send({ keys: ["tab"], text: note, enter: true }); setAmend(false); setNote(""); } }} className="mt-2 flex items-center gap-1.5 rounded-xl border border-border-strong bg-bg py-1 pr-1 pl-3">
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Yes, and tell Claude what to do next…" aria-label="instruction" className="no-ring h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
          <button type="submit" disabled={busy || !note.trim()} aria-label="Send" className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg disabled:opacity-25"><CornerDownLeft className="size-3.5" /></button>
        </form>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        <button type="button" disabled={busy} onClick={() => send({ keys: ["esc"] })} className={`${btn} text-fg-muted hover:bg-hover hover:text-fg`} title="Esc — skip / cancel"><X className="size-3.5" />Skip</button>
        {prompt.amend && <button type="button" onClick={() => setAmend((a) => !a)} className={`${btn} text-fg-muted hover:bg-hover hover:text-fg`} title="Tab — approve with an instruction">Add instruction</button>}
        {prompt.multi && <button type="button" disabled={busy} onClick={() => send({ keys: ["right"] })} className={`${btn} ml-auto bg-primary text-primary-fg hover:opacity-90`}>Next<ArrowRight className="size-3.5" /></button>}
      </div>
    </div>
  );
}

/** A prompt the parser doesn't know: the terminal text plus the raw keys, so nothing is ever unanswerable from the web. */
function RawCard({ screen, send, busy }: { screen: string; send: (a: Answer) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const keys: [string, React.ReactNode][] = [["up", <ArrowUp className="size-3.5" />], ["down", <ArrowDown className="size-3.5" />], ["left", <ArrowLeft className="size-3.5" />], ["right", <ArrowRight className="size-3.5" />], ["tab", "Tab"], ["space", "Space"], ["enter", <CornerDownLeft className="size-3.5" />], ["esc", "Esc"]];
  return (
    <div role="group" aria-label="Claude is waiting for input" className="fade-up rounded-2xl border border-border-strong bg-surface p-3.5 shadow-[var(--shadow)]">
      <pre className="mb-3 max-h-64 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre text-fg-muted">{screen.split("\n").filter((l) => l.trim()).slice(-24).join("\n")}</pre>
      <div className="flex flex-wrap gap-1">
        {keys.map(([k, label]) => <button key={k} type="button" disabled={busy} onClick={() => send({ keys: [k] })} className="inline-flex h-7 min-w-8 items-center justify-center rounded-lg border border-border px-2 text-[12px] hover:bg-hover disabled:opacity-40" aria-label={k}>{label}</button>)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (text) { send({ text, enter: true }); setText(""); } }} className="mt-2 flex items-center gap-1.5 rounded-xl border border-border bg-bg py-1 pr-1 pl-3">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type, then Enter…" aria-label="type into the session" className="no-ring h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
        <button type="submit" disabled={busy || !text} aria-label="Send" className="grid size-7 place-items-center rounded-full bg-primary text-primary-fg disabled:opacity-25"><CornerDownLeft className="size-3.5" /></button>
      </form>
    </div>
  );
}
