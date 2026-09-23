import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "./store";

export const ROOT = join(import.meta.dir, "..");
const skill = (name: string) => readFileSync(join(ROOT, "plugin", "skills", name, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");

const brief = (t: Ticket) =>
  `# Ticket ${t.id}: ${t.title}\npriority: ${t.priority} · tags: ${t.tags.join(", ") || "-"} · scope_paths: ${JSON.stringify(t.scope_paths)}\n\n` +
  ["Goal", "Context", "Acceptance", "Verify", "Timebox", "Forbidden"].map((k) => `## ${k}\n${t.sections[k] || "-"}`).join("\n\n");

/** first line of the worker skill body; lets the supervisor tell a full brief from a bare follow-up message */
export const WORKER_MARK = "# You are a factory worker";

export function workerPrompt(t: Ticket, rules: string, ctx: { branch: string; base: string; attempt: number; worktree: string }) {
  return `${skill("factory-worker")}

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

export function reviewerPrompt(t: Ticket, rules: string, ctx: { diff: string; verifyLog: string; workerSummary: string; implementer: string }) {
  return `${skill("factory-reviewer")}

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
