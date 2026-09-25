// pi bridge: factory tools (same definitions as the MCP server) + guard. Loaded with `pi -e`; no-op outside factory runs.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, ctxFromEnv, reportBlock, scopeFor } from "../src/guard";
import { TOOLS } from "../src/mcp";

export default function (pi: ExtensionAPI) {
  const ctx = ctxFromEnv();
  if (!ctx) return;
  const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_TOKEN } = process.env;

  for (const t of TOOLS) {
    if (!(t.roles as readonly string[]).includes(ctx.role)) continue;
    pi.registerTool({
      name: t.name,
      label: t.name.replace("factory_", "factory "),
      description: t.description,
      parameters: Type.Unsafe(t.inputSchema as any),
      async execute(_id: string, params: any, signal?: AbortSignal) {
        const res = await fetch(`${FACTORY_URL}/api/runs/${FACTORY_RUN_ID}/tool/${t.name}`, {
          method: "POST", headers: { "content-type": "application/json", "x-factory-token": FACTORY_TOKEN ?? "" },
          body: JSON.stringify(params), signal,
        });
        const data = (await res.json()) as { text?: string; error?: string };
        return { content: [{ type: "text", text: data.text ?? `factory error: ${data.error}` }], details: {} };
      },
    } as any);
  }

  pi.on("tool_call", async (event: any) => {
    const v = check(event.toolName, event.input, { ...ctx, scope: await scopeFor(event.toolName, ctx) });
    if (v.allow) return undefined;
    await reportBlock(event.toolName, v.reason);
    return { block: true, reason: v.reason };
  });
}
