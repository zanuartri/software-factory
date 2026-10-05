// Turns what Claude Code's TUI shows while it waits for the user (AskUserQuestion, permission, plan approval, trust) into data,
// so the web chat can render the same choices. Pure functions over the pane's text; actions are plain key presses (see daemon.ts).
// Claude doesn't write a pending question to its transcript, so the screen is the only source.

export type PromptOption = { n: number | null; label: string; desc?: string; checked: boolean | null; chosen: boolean; focused: boolean; input: boolean };
export type PromptTab = { label: string; done: boolean; submit: boolean; active: boolean };
export type Prompt = {
  title: string; context: string; tabs: PromptTab[]; options: PromptOption[]; multi: boolean;
  footer: string; amend: boolean; screen: string;
  /** side-by-side preview of the option the cursor is on (previews change as the cursor moves) */
  preview: string | null; notes: boolean;
};

const RULE = /^\s*[─╌━]{5,}.*$/; // a solid or dashed divider (the session name can trail a rule)
const FOOTER = /(Enter to (select|confirm)|Esc to cancel|to navigate|Tab to amend|ctrl\+g to edit)/i;
const NUMBERED = /^\s*(❯|>)?\s*(\d+)\.\s+(.*\S)\s*$/;
const INPUT_LABEL = /^(type something|tell claude|other\b)/i; // options that turn into a text field when picked

/** Plain text of the active tab, read from the ANSI rendering where the active tab has a background colour. */
function activeTabLabel(ansiLines: string[]): string | null {
  const line = ansiLines.find((l) => /[☐☒]/.test(l) && /→/.test(l) && /←/.test(l));
  const m = line?.match(/\x1b\[48;[\d;]+m([^\x1b]*)\x1b\[0m/);
  return m ? m[1].replace(/[☐☒✔]/g, "").trim() : null;
}

function parseTabs(line: string, active: string | null): PromptTab[] {
  const body = line.replace(/^\s*←/, "").replace(/→\s*$/, "");
  return [...body.matchAll(/([☐☒✔])\s+(.+?)(?=\s{2,}[☐☒✔]|\s*$)/g)].map((m) => ({
    label: m[2].trim(), done: m[1] === "☒", submit: m[1] === "✔", active: m[2].trim() === active,
  }));
}

export function parsePrompt(plain: string, ansi = ""): Prompt | null {
  const raw = plain.split("\n").map((l) => l.replace(/\s+$/, ""));
  // options with a preview are drawn two-column: choices on the left, a box with the focused option's preview on the right
  let boxCol = -1;
  for (const l of raw) { const m = l.match(/\S\s{2,}(┌─{3,}┐)$/); if (m) { boxCol = l.length - m[1].length; break; } }
  const inBox = (l: string) => boxCol >= 0 && "┌│└".includes(l[boxCol] ?? " ") && !l.slice(Math.max(0, boxCol - 2), boxCol).trim();
  const lines = raw.map((l) => (inBox(l) ? l.slice(0, boxCol).replace(/\s+$/, "") : l));
  const previewRows = raw.filter(inBox).map((l) => l.slice(boxCol)).filter((l) => l.startsWith("│"));
  const preview = previewRows.length ? previewRows.map((l) => l.replace(/^│ ?/, "").replace(/ ?│$/, "").replace(/\s+$/, "")).join("\n").replace(/\s+$/, "") : null;
  let f = -1;
  for (let i = raw.length - 1; i >= Math.max(0, raw.length - 30); i--) if (FOOTER.test(raw[i])) { f = i; break; }
  if (f < 0) {
    // some screens (the review step) print no footer: accept a numbered menu with the ❯ cursor sitting at the bottom of the screen
    let last = lines.length - 1;
    while (last >= 0 && (!lines[last].trim() || RULE.test(lines[last]))) last--;
    if (last < 0 || !NUMBERED.test(lines[last])) return null;
    let k = last;
    while (k >= 0 && lines.length - k < 30 && NUMBERED.test(lines[k])) k--;
    if (!lines.slice(k + 1, last + 1).some((l) => /^\s*❯\s*\d+\./.test(l))) return null;
    f = last + 1;
  }

  // numbered options: walk up from the footer collecting 1..N (a rule may sit between the last options)
  const idx: number[] = [];
  let want = -1;
  for (let i = f - 1; i >= Math.max(0, f - 60); i--) {
    const m = lines[i].match(NUMBERED);
    if (!m) continue;
    const n = +m[2];
    if (want === -1 || n === want) { idx.unshift(i); want = n - 1; if (n === 1) break; }
  }
  let opts: { i: number; n: number | null; text: string; focused: boolean }[];
  if (idx.length && lines[idx[0]].match(NUMBERED)![2] === "1") {
    opts = idx.map((i) => { const m = lines[i].match(NUMBERED)!; return { i, n: +m[2], text: m[3], focused: !!m[1] }; });
  } else {
    // unnumbered menu (the folder-trust dialog): the block right above the footer, one line per choice, ❯ marks the cursor
    let end = f - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    let top = end;
    while (top >= 0 && lines[top].trim() && !RULE.test(lines[top])) top--;
    const block = lines.slice(top + 1, end + 1).filter((l) => l.trim());
    if (block.length < 2 || !block.some((l) => /^\s*❯/.test(l))) return null;
    opts = block.map((l, k) => ({ i: top + 1 + k, n: null, text: l.replace(/^\s*❯\s*/, "").trim(), focused: /^\s*❯/.test(l) }));
  }

  if (!opts.some((o) => /^chat about this$/i.test(o.text))) { // unnumbered trailing choice (preview layout)
    const c = lines.findIndex((l, i) => i > opts.at(-1)!.i && i < f && /^\s*(❯\s*)?Chat about this\s*$/.test(l));
    if (c >= 0) opts.push({ i: c, n: null, text: "Chat about this", focused: /❯/.test(lines[c]) });
  }
  const options: PromptOption[] = opts.map((o, k) => {
    const next = k + 1 < opts.length ? opts[k + 1].i : f;
    const desc = lines.slice(o.i + 1, next).filter((l) => l.trim() && !/^\s*Notes:/.test(l) && !RULE.test(l) && !/^\s*(Submit|\d+\.)\s*$/.test(l) && !NUMBERED.test(l)).map((l) => l.trim()).join(" ");
    let label = o.text, checked: boolean | null = null;
    const box = label.match(/^\[([ ✔xX])\]\s*(.*)$/);
    if (box) { checked = box[1] !== " "; label = box[2]; }
    const chosen = / ✔$/.test(label);
    label = label.replace(/ ✔$/, "").trim();
    return { n: o.n, label, desc: desc && desc !== label ? desc : undefined, checked, chosen, focused: o.focused, input: INPUT_LABEL.test(label) };
  });

  // title: the text block right above the first option; context: everything above it back to the last chat message
  const first = opts[0].i;
  let t = first - 1;
  while (t >= 0 && !lines[t].trim()) t--;
  const titleLines: string[] = [];
  while (t >= 0 && lines[t].trim() && !RULE.test(lines[t]) && !/^\s*←.*→\s*$/.test(lines[t]) && !/^\s*[●⚠→☐☒✔]/.test(lines[t])) titleLines.unshift(lines[t--].trim());
  let tabLine: string | null = null;
  const ctx: string[] = [];
  for (let i = t; i >= Math.max(0, t - 80); i--) { // context runs up to the last chat message; the tab bar may sit among it
    if (/^[●✻❯]/.test(lines[i]) || /^\s*[☐☒✔]\s/.test(lines[i])) break; // a lone "☐ Header" line (single question, no tab bar) ends the context too
    if (/^\s*←.*→\s*$/.test(lines[i])) { tabLine = lines[i]; break; }
    if (!RULE.test(lines[i])) ctx.unshift(lines[i]);
  }
  while (ctx.length && !ctx[0].trim()) ctx.shift();
  while (ctx.length && !ctx.at(-1)!.trim()) ctx.pop();
  const indent = Math.min(...ctx.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length), 99);

  const ansiLines = ansi.split("\n");
  return {
    title: titleLines.join(" "),
    context: ctx.map((l) => l.slice(Number.isFinite(indent) && indent < 99 ? indent : 0)).join("\n"),
    tabs: tabLine ? parseTabs(tabLine, activeTabLabel(ansiLines)) : [],
    options, multi: options.some((o) => o.checked !== null),
    footer: (raw[f] ?? "").trim(), amend: /Tab to amend/i.test(raw[f] ?? ""), screen: plain,
    preview: preview && options.some((o) => o.focused) ? preview : null, notes: /n to add notes/i.test(raw[f] ?? ""),
  };
}
