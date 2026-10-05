import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "./store";

export const ROOT = join(import.meta.dir, "..");
const skill = (name: string) => readFileSync(join(ROOT, "plugin", "skills", name, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");

/** Personas are short skills (plugin/skills/persona-<name>) appended to the worker prompt. A ticket tag named after one picks it;
 *  otherwise the title's wording does. Advisory flavour only: nothing depends on a match. */
const PERSONA_WORDS: [string, RegExp][] = [
  ["bug", /\b(bug|fix|hotfix|regression|crash)/i], ["ui", /\b(ui|frontend|css|layout|a11y|accessib)/i], ["refactor", /\b(refactor|clean ?up|restructure)/i],
  ["test", /\b(tests?|coverage)\b/i], ["research", /\b(research|investigat|spike|analy[sz]e)/i], ["feature", /\b(feature|add|implement|support)\b/i],
];
export function personasFor(t: Pick<Ticket, "tags" | "title">): string[] {
  const have = (n: string) => existsSync(join(ROOT, "plugin", "skills", `persona-${n}`, "SKILL.md"));
  const byTag = PERSONA_WORDS.map(([n]) => n).filter((n) => t.tags.includes(n) && have(n));
  const picked = byTag.length ? byTag : PERSONA_WORDS.filter(([n, re]) => re.test(t.title) && have(n)).map(([n]) => n);
  return picked.slice(0, 2);
}

const brief = (t: Ticket) =>
  `# Ticket ${t.id}: ${t.title}\npriority: ${t.priority} · tags: ${t.tags.join(", ") || "-"} · scope_paths: ${JSON.stringify(t.scope_paths)}\n\n` +
  ["Goal", "Context", "Acceptance", "Verify", "Timebox", "Forbidden"].map((k) => `## ${k}\n${t.sections[k] || "-"}`).join("\n\n");

/** first line of the worker skill body; lets the supervisor tell a full brief from a bare follow-up message */
export const WORKER_MARK = "# You are a factory worker";

export function workerPrompt(t: Ticket, rules: string, ctx: { branch: string; base: string; attempt: number; worktree: string }) {
  const personas = personasFor(t).map((n) => skill(`persona-${n}`).trim());
  return `${skill("worker")}${personas.length ? `\n\n---\n${personas.join("\n\n")}` : ""}

---
# Standing orders (verbatim from .factory/rules.md — obey every line)
${rules}

---
# Your run
worktree: ${ctx.worktree}
branch: ${ctx.branch} (base: ${ctx.base}) — commit here, never switch branches
attempt: ${ctx.attempt}

${brief(t)}

Begin with the Plan phase now. Call factory_report at every phase boundary.`;
}

export function reviewerPrompt(t: Ticket, rules: string, ctx: { diff: string; verifyLog: string; workerSummary: string; implementer: string; outOfScope?: string[] }) {
  return `${skill("reviewer")}

---
# Standing orders of this repo
${rules}

---
# What you are reviewing
implementer harness: ${ctx.implementer} (you are deliberately a different model family)

${brief(t)}

## Implementer's summary
${ctx.workerSummary || "-"}

## Daemon verify results (already executed independently)
${ctx.verifyLog}
${ctx.outOfScope?.length ? `
## Files changed outside the ticket's scope_paths
${ctx.outOfScope.map((f) => `- ${f}`).join("\n")}
scope_paths is advisory: judge whether each is a justified, necessary part of the change (a test, a shared helper, a caller). Flag only the ones that are drive-by or risky.
` : ""}
## Diff vs base
\`\`\`diff
${ctx.diff}
\`\`\`

Review now, then call factory_verdict exactly once.`;
}

export const gateFailPrompt = (attempt: number, max: number, findings: string) =>
  `# Gate failed (attempt ${attempt}/${max})
The factory gate rejected your submission. Fix the root cause of every finding below, verify, commit, then call factory_submit again.
Do not argue with the findings in prose; if one is wrong, record why with factory_decision and show evidence.

${findings}`;

export const conflictPrompt = (base: string, files: string[]) =>
  `# Base moved: merge conflict
The daemon merged latest \`${base}\` into your branch and it conflicts in:
${files.map((f) => `- ${f}`).join("\n")}
Resolve the conflict markers keeping both intents, run Verify, \`git add\` + \`git commit\` (no rebase), then factory_submit again.`;
