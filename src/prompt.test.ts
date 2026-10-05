import { expect, test } from "bun:test";
import { parsePrompt } from "./prompt";

const R = "─".repeat(60);
const screen = (...l: string[]) => l.join("\n");

test("AskUserQuestion: tabs, the active tab from ANSI, options with descriptions, type-in option", () => {
  const plain = screen("❯ Call the tool", R, "←  ☐ A  ☐ B  ✔ Submit  →", "Pick A?", "❯ 1. x", "     desc of x", "  2. y", "  3. Type something.", R, "  4. Chat about this", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel");
  const ansi = "\x1b[0m\x1b[38;2;153;153;153m← \x1b[0m\x1b[38;2;0;0;0m\x1b[48;2;177;185;249m ☐ B \x1b[0m ☐ A  ✔ Submit  →";
  const p = parsePrompt(plain, ansi)!;
  expect(p.title).toBe("Pick A?");
  expect(p.tabs.map((t) => [t.label, t.active, t.submit])).toEqual([["A", false, false], ["B", true, false], ["Submit", false, true]]);
  expect(p.options.map((o) => [o.n, o.label, o.input, o.focused])).toEqual([[1, "x", false, true], [2, "y", false, false], [3, "Type something.", true, false], [4, "Chat about this", false, false]]);
  expect(p.options[0].desc).toBe("desc of x");
  expect(p.multi).toBe(false);
  expect(p.context).toBe("");
});

test("AskUserQuestion multi-select: checkboxes and the unnumbered Submit row", () => {
  const p = parsePrompt(screen("Pick toppings?", "❯ 1. [✔] Cheese", "         Cheese", "  2. [ ] Olives", "  3. [ ] Type something", "     Submit", R, "  4. Chat about this", "Enter to select · ↑/↓ to navigate · Esc to cancel"))!;
  expect(p.multi).toBe(true);
  expect(p.options.map((o) => [o.label, o.checked])).toEqual([["Cheese", true], ["Olives", false], ["Type something", false], ["Chat about this", null]]);
  expect(p.options[2].input).toBe(true);
  expect(p.tabs).toEqual([]);
});

test("review screen: a numbered menu whose context is the answers", () => {
  const p = parsePrompt(screen("←  ☒ Color  ✔ Submit  →", "Review your answers", " ● Pick a color?", "   → Green", "Ready to submit your answers?", "❯ 1. Submit answers", "  2. Cancel", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"))!;
  expect(p.title).toBe("Ready to submit your answers?");
  expect(p.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  expect(p.tabs.map((t) => t.done)).toEqual([true, false]);
});

test("permission prompt: context above the question, Tab amends", () => {
  const p = parsePrompt(screen("● Write(perm-test.txt)", R, " Create file", " perm-test.txt", "╌".repeat(40), "  1 hello", "╌".repeat(40), " Do you want to create perm-test.txt?", " ❯ 1. Yes", "   2. Yes, and switch to accept edits (auto-approve file edits) for this session (shift+tab)", "   3. No", " Esc to cancel · Tab to amend"))!;
  expect(p.title).toBe("Do you want to create perm-test.txt?");
  expect(p.context).toBe("Create file\nperm-test.txt\n 1 hello");
  expect(p.options.map((o) => o.label)[2]).toBe("No");
  expect(p.amend).toBe(true);
});

test("plan approval: the tell-Claude option takes text", () => {
  const p = parsePrompt(screen("   Plan: create hello.txt", R, "   Claude has written up a plan and is ready to execute. Would you like to proceed?", "   ❯ 1. Yes, and use auto mode", "     2. Yes, manually approve edits", "     3. Tell Claude what to change", "        shift+tab to approve with this feedback", "   ctrl+g to edit in Notepad · ~/.claude/plans/x.md"))!;
  expect(p.title).toContain("Would you like to proceed?");
  expect(p.options.map((o) => o.input)).toEqual([false, false, true]);
});

test("folder trust dialog: unnumbered options, cursor marks the focus", () => {
  const p = parsePrompt(screen("Claude Code'll be able to read, edit, and execute files here.", "", "Security guide", "", "❯ No, exit", "  Yes, I trust this folder", "", "Enter to confirm · Esc to cancel"))!;
  expect(p.options.map((o) => [o.n, o.label, o.focused])).toEqual([[null, "No, exit", true], [null, "Yes, I trust this folder", false]]);
});

test("a normal screen is not a prompt", () => {
  expect(parsePrompt(screen("● done", R, "❯", R, "  ⏵⏵ auto mode on (shift+tab to cycle)"))).toBeNull();
});

test("review step prints no footer: the ❯ cursor on a bottom-of-screen menu is enough", () => {
  const p = parsePrompt(screen("←  ☒ Color  ✔ Submit  →", "Review your answers", " ● Pick a color?", "   → Green", "", "Ready to submit your answers?", "", "❯ 1. Submit answers", "  2. Cancel", "", R))!;
  expect(p.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  expect(p.title).toBe("Ready to submit your answers?");
  // chat output that merely contains a numbered list is not a prompt
  expect(parsePrompt(screen("● Steps:", "  1. do a", "  2. do b", "", R, "❯", R))).toBeNull();
});

test("options with a preview: the right-hand box belongs to the focused option, notes are offered", () => {
  const p = parsePrompt(screen(
    "❯ Call AskUserQuestion", R, " ☐ Layout", "Which layout?",
    "❯ 1. Kanban                       ┌──────────────────────────────────────────┐",
    "  2. List                         │ ┌───────┬───────┬───────┐                │",
    "  3. Table                        │ │ To Do │ Doing │ Done  │                │",
    "                                  │ └───────┴───────┴───────┘                │",
    "                                  └──────────────────────────────────────────┘",
    "                                  Notes: press n to add notes",
    R, "  Chat about this", "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"))!;
  expect(p.options.map((o) => [o.n, o.label, o.desc, o.focused])).toEqual([[1, "Kanban", undefined, true], [2, "List", undefined, false], [3, "Table", undefined, false], [null, "Chat about this", undefined, false]]);
  expect(p.preview).toBe("┌───────┬───────┬───────┐\n│ To Do │ Doing │ Done  │\n└───────┴───────┴───────┘");
  expect(p.notes).toBe(true);
  expect(p.title).toBe("Which layout?");
});
