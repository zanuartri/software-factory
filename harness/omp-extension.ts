// omp bridge: factory tools (same definitions as the MCP server) + guard. Loaded with `omp -e`; no-op outside factory runs.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { check, ctxFromEnv, reportBlock } from "../src/guard";
import { TOOLS } from "../src/mcp";

export default function (omp: ExtensionAPI) {
  const ctx = ctxFromEnv();
  if (!ctx) return;
  const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_TOKEN } = process.env;

  for (const t of TOOLS) {
    if (!(t.roles as readonly string[]).includes(ctx.role)) continue;
    omp.registerTool({
      name: t.name,
      label: t.name.replace("factory_", "factory "),
      description: t.description,
      parameters: t.inputSchema as any, // omp takes plain JSON Schema
      loadMode: "essential", // extension tools default to "discoverable" (reachable only via xd://); the worker must see factory_* up front
      approval: "read",
      async execute(_id: string, params: any, signal?: AbortSignal) { // omp: (toolCallId, params, signal, onUpdate, ctx)
        const res = await fetch(`${FACTORY_URL}/api/runs/${FACTORY_RUN_ID}/tool/${t.name}`, {
          method: "POST", headers: { "content-type": "application/json", "x-factory-token": FACTORY_TOKEN ?? "" },
          body: JSON.stringify(params), signal,
        });
        const data = (await res.json()) as { text?: string; error?: string };
        return { content: [{ type: "text", text: data.text ?? `factory error: ${data.error}` }], details: {} };
      },
    } as any);
  }

  omp.on("tool_call", async (event: any) => {
    const v = check(event.toolName, event.input, ctx);
    if (v.allow) return undefined;
    await reportBlock(event.toolName, v.reason);
    return { block: true, reason: v.reason };
  });
}
