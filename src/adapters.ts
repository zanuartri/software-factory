// One HarnessAdapter per CLI. Everything harness-specific lives here; the supervisor only sees Handle + normalized events.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "./db";
import { ROOT } from "./prompts";

export type Caps = { liveSteer: boolean; abort: boolean; resume: boolean; oneProcPerTurn: boolean };
export type NormEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "turn_end"; usage?: number; error?: string }
  | { type: "exit"; code: number | null };

export type StartOpts = {
  runId: string; role: "worker" | "reviewer"; cwd: string; runDir: string; prompt: string; model?: string;
  mcpUrl: string; env: Record<string, string>; resumeSession?: string | null; allowedTools?: string[];
  onEvent: (e: NormEvent) => void;
};
export type Handle = {
  pid: number | null;
  /** new user turn if idle; steer mid-turn when the harness supports it */
  send(text: string, mode?: "prompt" | "steer"): Promise<void>;
  abort(): Promise<void>;
  kill(): void;
};
export type Adapter = { caps: Caps; start(o: StartOpts): Promise<Handle> };

export function killTree(pid: number | null | undefined) {
  if (!pid) return;
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  else try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

/** Strict LF framing (pi docs: never split on U+2028). */
async function lines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (l.trim()) onLine(l);
    }
  }
}
const tryJson = (l: string) => { try { return JSON.parse(l); } catch { return null; } };

/**
 * On Windows, npm-style `.cmd` shims sit between us and the real process, and killing the shim can orphan the child
 * (which then also keeps the daemon's inherited socket open). Resolve the shim to the real exe / node script.
 */
export function bin(name: string): string[] {
  const found = Bun.which(name);
  if (process.platform !== "win32" || !found?.toLowerCase().endsWith(".cmd")) return [found ?? name];
  const text = readFileSync(found, "utf8");
  const dir = found.replace(/[\\/][^\\/]+$/, "");
  const target = [...text.matchAll(/"?%~?dp0%?\\?([^"\s%]+\.(?:exe|m?js))"?/gi)].at(-1)?.[1];
  if (!target) return [found];
  const full = join(dir, target);
  return full.toLowerCase().endsWith(".exe") ? [full] : ["node", full];
}
const transcript = (o: StartOpts) => (l: string) => appendFileSync(join(o.runDir, "transcript.jsonl"), l + "\n");
const baseEnv = (o: StartOpts) => ({ ...process.env, ...o.env }) as Record<string, string>;
const guardCmd = `bun "${join(ROOT, "src", "guard-hook.ts").replace(/\\/g, "/")}"`;

// ---------------------------------------------------------------- claude
const claude: Adapter = {
  caps: { liveSteer: true, abort: true, resume: true, oneProcPerTurn: false },
  async start(o) {
    const mcp = join(o.runDir, "mcp.json"), settings = join(o.runDir, "claude-settings.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { factory: { type: "http", url: o.mcpUrl } } }));
    writeFileSync(settings, JSON.stringify({
      permissions: { allow: [...(o.role === "reviewer" ? ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"] : o.allowedTools ?? []), "mcp__factory"] },
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCmd }] }] },
    }));
    const args = [...bin("claude"), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--mcp-config", mcp, "--settings", settings, "--permission-mode", o.role === "reviewer" ? "default" : "acceptEdits"];
    if (o.model) args.push("--model", o.model);
    if (o.resumeSession) args.push("--resume", o.resumeSession);
    const p = Bun.spawn(args, { cwd: o.cwd, env: baseEnv(o), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const log = transcript(o);
    const write = (obj: any) => { p.stdin.write(JSON.stringify(obj) + "\n"); p.stdin.flush(); };
    const user = (text: string) => write({ type: "user", message: { role: "user", content: text } });
    lines(p.stdout, (l) => {
      log(l);
      const e = tryJson(l);
      if (!e) return;
      if (e.type === "system" && e.subtype === "init") o.onEvent({ type: "session", id: e.session_id });
      if (e.type === "assistant") for (const c of e.message?.content ?? []) {
        if (c.type === "text") o.onEvent({ type: "text", text: c.text });
        if (c.type === "tool_use") o.onEvent({ type: "tool", name: c.name, detail: JSON.stringify(c.input).slice(0, 200) });
      }
      if (e.type === "result") o.onEvent({ type: "turn_end", usage: (e.usage?.input_tokens ?? 0) + (e.usage?.output_tokens ?? 0), error: e.is_error ? e.result : undefined });
    });
    lines(p.stderr, (l) => log(JSON.stringify({ stderr: l })));
    p.exited.then((code) => o.onEvent({ type: "exit", code }));
    user(o.prompt);
    return {
      pid: p.pid,
      async send(text) { user(text); }, // stream-json queues it into the running session
      async abort() { write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } }); },
      kill() { try { p.stdin.end(); } catch {} killTree(p.pid); },
    };
  },
};

// ---------------------------------------------------------------- pi (rpc)
const pi: Adapter = {
  caps: { liveSteer: true, abort: true, resume: true, oneProcPerTurn: false },
  async start(o) {
    const args = [...bin("pi"), "--mode", "rpc", "--session-dir", join(o.runDir, "pi-sessions"),
      "-e", join(ROOT, "harness", "pi-extension.ts"), "--approve"];
    if (o.model) args.push("--model", o.model);
    if (o.resumeSession) args.push("--continue");
    if (o.role === "reviewer") args.push("--tools", "read,grep,find,ls,factory_report,factory_decision,factory_verdict,factory_ask");
    const p = Bun.spawn(args, { cwd: o.cwd, env: baseEnv(o), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const log = transcript(o);
    const write = (obj: any) => { p.stdin.write(JSON.stringify(obj) + "\n"); p.stdin.flush(); };
    let running = false;
    lines(p.stdout, (l) => {
      const e = tryJson(l);
      if (e?.type !== "message_update") log(l); // streaming deltas would bloat the transcript 50x; message_end has the full text
      if (!e) return;
      if (e.type === "agent_start") running = true;
      if (e.type === "tool_execution_start") o.onEvent({ type: "tool", name: e.toolName, detail: JSON.stringify(e.args ?? {}).slice(0, 200) });
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        if (text) o.onEvent({ type: "text", text });
      }
      if (e.type === "agent_settled") { running = false; o.onEvent({ type: "turn_end" }); }
      if (e.type === "response" && e.command === "get_state" && e.data?.sessionId) o.onEvent({ type: "session", id: e.data.sessionId });
    });
    lines(p.stderr, (l) => log(JSON.stringify({ stderr: l })));
    p.exited.then((code) => o.onEvent({ type: "exit", code }));
    write({ type: "get_state" });
    write({ type: "prompt", message: o.prompt });
    return {
      pid: p.pid,
      async send(text) { write({ type: running ? "steer" : "prompt", message: text }); }, // steer lands after the current tool batch
      async abort() { write({ type: "abort" }); },
      kill() { try { p.stdin.end(); } catch {} killTree(p.pid); },
    };
  },
};

// ---------------------------------------------------------------- opencode (serve)
const opencode: Adapter = {
  caps: { liveSteer: false, abort: true, resume: true, oneProcPerTurn: false },
  async start(o) {
    const config = {
      mcp: { factory: { type: "remote", url: o.mcpUrl, enabled: true } },
      // explicit on every key: a headless "ask" would wait forever. Other worktrees are off-limits (isolation).
      permission: { edit: o.role === "reviewer" ? "deny" : "allow", bash: o.role === "reviewer" ? "deny" : "allow", webfetch: "deny", external_directory: "deny", doom_loop: "deny" },
    };
    const p = Bun.spawn([...bin("opencode"), "serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: o.cwd, env: { ...baseEnv(o), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const log = transcript(o);
    const url = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("opencode serve did not report a port in 90s")), 90e3);
      const seen = (l: string) => { log(JSON.stringify({ serve: l })); const m = l.match(/https?:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(t); res(m[0]); } };
      lines(p.stdout, seen); lines(p.stderr, seen);
    });
    const api = (path: string, body?: any) => fetch(url + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    let sid = o.resumeSession;
    if (!sid) sid = (await (await api("/session", { title: o.runId })).json()).id as string;
    o.onEvent({ type: "session", id: sid! });
    const [providerID, ...rest] = (o.model ?? "").split("/");
    const prompt = (text: string) => api(`/session/${sid}/prompt_async`, { parts: [{ type: "text", text }], ...(o.model ? { model: { providerID, modelID: rest.join("/") } } : {}) });
    // SSE: session.idle marks the end of a turn
    (async () => {
      const res = await fetch(url + "/event");
      let buf = "";
      for await (const chunk of res.body!) {
        buf += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
          const e = tryJson(data); if (!e) continue;
          const props = e.properties ?? {};
          if (props.sessionID && props.sessionID !== sid && props.info?.sessionID !== sid && props.part?.sessionID !== sid) continue;
          if (e.type === "server.heartbeat") continue;
          log(data);
          // belt and braces: nobody can click "allow" in a headless run, so any permission prompt is rejected with a reason
          if (e.type === "permission.asked") api(`/permission/${props.id}/reply`, { reply: "reject", message: "Headless factory worker: this action needs factory_ask (or is outside your worktree)." });
          if (e.type === "message.part.updated" && props.part?.type === "tool" && props.part.state?.status === "running") o.onEvent({ type: "tool", name: props.part.tool });
          if (e.type === "message.part.updated" && props.part?.type === "text" && props.part.time?.end) o.onEvent({ type: "text", text: props.part.text });
          if (e.type === "session.idle") o.onEvent({ type: "turn_end" });
          if (e.type === "session.error") o.onEvent({ type: "turn_end", error: JSON.stringify(props.error ?? {}) });
        }
      }
    })().catch((err) => log(JSON.stringify({ sse_error: String(err) })));
    p.exited.then((code) => o.onEvent({ type: "exit", code }));
    await prompt(o.prompt);
    return {
      pid: p.pid,
      async send(text) { await prompt(text); }, // queued by opencode after the current turn; factory tools piggyback meanwhile
      async abort() { await api(`/session/${sid}/abort`, {}); },
      kill() { killTree(p.pid); },
    };
  },
};

// ---------------------------------------------------------------- commandcode (-p NDJSON, one process per turn)
const commandcode: Adapter = {
  caps: { liveSteer: false, abort: true, resume: true, oneProcPerTurn: true },
  async start(o) {
    // async: spawnSync here would freeze the whole daemon for several seconds
    await Bun.spawn([...bin("commandcode"), "mcp", "remove", "factory"], { cwd: o.cwd, stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
    await Bun.spawn([...bin("commandcode"), "mcp", "add", "--transport", "http", "--scope", "local", "factory", o.mcpUrl], { cwd: o.cwd, stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
    let sid = o.resumeSession ?? null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    const log = transcript(o);
    const turn = (text: string) => {
      const args = [...bin("commandcode"), "-p", "--output-format", "json", "--trust", "--skip-onboarding", "--max-turns", "300"];
      if (o.role === "worker") args.push("--yolo"); // guard = PreToolUse hook (installed by `factory setup`) + daemon post-check
      if (o.model) args.push("-m", o.model);
      if (sid) args.push("--resume", sid);
      const p = Bun.spawn(args, { cwd: o.cwd, env: baseEnv(o), stdin: new Blob([text]), stdout: "pipe", stderr: "pipe", windowsHide: true });
      proc = p;
      lines(p.stdout, (l) => {
        log(l);
        const e = tryJson(l);
        if (e?.type === "event" && e.event?.type === "tool_running") o.onEvent({ type: "tool", name: e.event.toolName, detail: e.event.description });
        if (e?.type === "result") {
          if (e.sessionId && e.sessionId !== sid) { sid = e.sessionId; o.onEvent({ type: "session", id: sid! }); }
          if (p !== proc) return; // superseded turn: its late result must not nudge or idle the replacement turn
          if (e.finalText) o.onEvent({ type: "text", text: e.finalText });
          o.onEvent({ type: "turn_end", usage: (e.usage?.inputTokens ?? e.usage?.input_tokens ?? 0) + (e.usage?.outputTokens ?? e.usage?.output_tokens ?? 0), error: e.subtype === "error" ? e.error : undefined });
        }
      });
      lines(p.stderr, (l) => log(JSON.stringify({ stderr: l })));
    };
    turn(o.prompt);
    return {
      get pid() { return proc?.pid ?? null; },
      async send(text) { if (proc && proc.exitCode === null) { killTree(proc.pid); await proc.exited; } turn(text); },
      async abort() { if (proc) { killTree(proc.pid); await proc.exited; } }, // old turn fully stopped before the resume turn starts
      kill() { if (proc) killTree(proc.pid); o.onEvent({ type: "exit", code: null }); },
    };
  },
};

export const ADAPTERS: Record<Harness, Adapter> = { claude, pi, opencode, commandcode };
