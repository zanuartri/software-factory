// opencode guard. Installed globally by `factory setup` (~/.config/opencode/plugins/factory-guard.ts re-exports this);
// no-op unless the process is a factory run. Factory tools reach opencode via MCP (OPENCODE_CONFIG_CONTENT).
import { check, ctxFromEnv, reportBlock } from "../src/guard";

export const FactoryGuard = async () => {
  const ctx = ctxFromEnv();
  if (!ctx) return {};
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args: any }) => {
      const v = check(input.tool, output.args, ctx);
      if (!v.allow) {
        await reportBlock(input.tool, v.reason);
        throw new Error(v.reason);
      }
    },
  };
};
