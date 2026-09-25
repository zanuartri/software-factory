// PreToolUse hook for claude + commandcode (same stdin shape: {tool_name, tool_input}). No-op outside factory runs.
import { check, ctxFromEnv, reportBlock, scopeFor } from "./guard";

const ctx = ctxFromEnv();
if (!ctx) process.exit(0);
const payload = JSON.parse((await Bun.stdin.text()) || "{}");
const v = check(payload.tool_name ?? "", payload.tool_input ?? {}, { ...ctx, scope: await scopeFor(payload.tool_name ?? "", ctx) });
if (!v.allow) {
  await reportBlock(payload.tool_name, v.reason);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason } }));
}
