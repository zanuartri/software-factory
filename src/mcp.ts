// Minimal MCP server: streamable-HTTP transport answering plain JSON (no SSE, no sessions). One URL per run.
// ponytail: hand-rolled because we only need initialize / tools/list / tools/call; switch to @modelcontextprotocol/sdk if we need resources or server push.

const str = (description: string) => ({ type: "string", description });
export const TOOLS = [
  {
    name: "factory_report", roles: ["worker", "reviewer"],
    description: "Report progress at every phase/unit boundary (plan, implement, test, review). Returns any pending messages from the manager — read and obey them.",
    inputSchema: { type: "object", required: ["phase", "summary"], properties: { phase: { type: "string", enum: ["plan", "implement", "test", "review", "fix", "wrap-up"] }, summary: str("one or two lines: what just finished, what is next") } },
  },
  {
    name: "factory_decision", roles: ["worker", "reviewer"],
    description: "Append one row to the decision log (show-me-your-work). Use for every non-obvious choice, reversible call made without asking, deviation from the brief, or discarded attempt.",
    inputSchema: { type: "object", required: ["decision", "why", "evidence", "result"], properties: { decision: str("what was chosen or done, one line"), why: str("plain reason; name the principle if one drove it"), evidence: str("pointer: commit sha, file:line, command + outcome, artifact path — never prose"), result: str("tests green / reverted / open / INCONCLUSIVE ...") } },
  },
  {
    name: "factory_ask", roles: ["worker"],
    description: "Ask the manager ONLY for irreversible actions, product/preference calls no experiment settles, needing to leave scope_paths, or a real dead end. Always give options and your default. Blocks until answered or timed out; on timeout the default is applied unless irreversible.",
    inputSchema: { type: "object", required: ["question", "options", "default"], properties: { question: str("self-contained question with context"), options: { type: "array", items: { type: "string" } }, default: str("the option you will take if nobody answers"), irreversible: { type: "boolean" } } },
  },
  {
    name: "factory_inbox", roles: ["worker", "reviewer"],
    description: "Fetch pending manager messages without reporting progress.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "factory_submit", roles: ["worker"],
    description: "Hand the ticket to the factory gate when every Acceptance item is met, Verify passes locally and all work is committed. The daemon independently re-runs Verify, checks the diff stays in scope and runs a cross-family reviewer. Use status=blocked with a write-up if you hit a genuine dead end. After calling, end your turn and wait.",
    inputSchema: { type: "object", required: ["status", "report"], properties: { status: { type: "string", enum: ["ready", "blocked"] }, report: str("markdown REPORT: what changed, what you actually ran and its result, acceptance checklist with evidence, deviations, follow-ups, principles applied and the decision each changed") } },
  },
  {
    name: "factory_verdict", roles: ["reviewer"],
    description: "Deliver your review verdict exactly once. PASS only if you would merge it as-is.",
    inputSchema: { type: "object", required: ["verdict", "findings"], properties: { verdict: { type: "string", enum: ["PASS", "FAIL"] }, findings: str("markdown: numbered findings, each with file:line, severity (blocker/major/minor), and the concrete fix. Minor-only → PASS.") } },
  },
] as const;

export type ToolCall = (name: string, args: any) => Promise<string>;

export async function handleMcp(req: Request, role: "worker" | "reviewer", call: ToolCall): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const msg = await req.json();
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(batch.map((m) => one(m, role, call)))).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(msg) ? out : out[0]);
}

async function one(m: any, role: string, call: ToolCall) {
  if (m.id === undefined) return null; // notification
  const ok = (result: any) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "factory", version: "0.1.0" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.filter((t) => (t.roles as readonly string[]).includes(role)).map(({ roles, ...t }) => t) });
    case "tools/call":
      try {
        return ok({ content: [{ type: "text", text: await call(m.params.name, m.params.arguments ?? {}) }] });
      } catch (e: any) {
        return ok({ content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } };
  }
}
