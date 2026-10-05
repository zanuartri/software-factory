import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, Handle, NormEvent, StartOpts } from "./adapters";
import type { Ticket } from "./store";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-")); // before the db module opens ~/.factory
const { abortRun, registerWorkspace, startAdapter } = await import("./supervisor");
const { ADAPTERS } = await import("./adapters");
const { HOME, db, getRun, updateRun } = await import("./db");
const store = await import("./store");

/** Commandcode-style fake: one process per turn, liveSteer false, send() replaces the current turn.
 *  abort() kills the turn but its late result still fires — the race that stomped the resume turn. */
function fakeCcAdapter() {
  const turns: string[] = [];
  let current: { die: () => void; exited: Promise<void> } | null = null;
  let onEvent: (e: NormEvent) => void = () => {};
  const startTurn = (text: string) => {
    turns.push(text);
    let die!: () => void;
    const exited = new Promise<void>((res) => (die = res));
    current = { die, exited };
  };
  const adapter: Adapter = {
    caps: { liveSteer: false, abort: true, resume: true, oneProcPerTurn: true },
    async start(o: StartOpts): Promise<Handle> {
      onEvent = o.onEvent;
      startTurn(o.prompt);
      return {
        pid: 424242,
        async send(text) { const cur = current; if (cur) { current = null; cur.die(); await cur.exited; } startTurn(text); },
        async abort() { const cur = current; current = null; cur?.die(); onEvent({ type: "turn_end" }); },
        kill() { current?.die(); current = null; },
      };
    },
  };
  return { adapter, turns };
}

const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
Bun.spawnSync(["git", "init", repo]);
const ws = registerWorkspace(repo);
store.writeTicket({
  id: "T-1", title: "abort test", status: "in_progress", priority: "p2", tags: [], depends_on: [], scope_paths: [],
  harness: "any", model: "default", difficulty: "medium", created: "", sections: { Goal: "g" }, file: join(repo, ".factory", "tickets", "T-1.md"),
});

const real = ADAPTERS.commandcode;
afterAll(() => { ADAPTERS.commandcode = real; });
const addRun = (status: string) => {
  const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.query("INSERT INTO runs (id,ws,ticket,role,harness,model,status,phase,branch,worktree,attempt,token,started_at,heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ws.id, "T-1", "worker", "commandcode", null, status, "fix", "b", join(repo, "wt"), 1, "tok", Date.now(), Date.now());
  return id;
};
const begin = async (id: string) => {
  mkdirSync(join(HOME, "runs", ws.id, "T-1", id), { recursive: true });
  await startAdapter(getRun(id)!, "start prompt", {});
};

test("abort+resume: the killed turn's late turn_end must not steal the resume turn", async () => {
  const fake = fakeCcAdapter();
  ADAPTERS.commandcode = fake.adapter;
  const id = addRun("running");
  await begin(id);
  await abortRun(id, "stop that");
  expect(fake.turns).toHaveLength(2); // initial turn + exactly one resume turn (no nudge turn)
  expect(fake.turns[1]).toContain("⛔ Interrupted by the manager:");
  expect(fake.turns[1]).toContain("stop that");
  expect(getRun(id)!.status).toBe("running");
});

test("abort+resume unparks a paused run instead of leaving it paused", async () => {
  const fake = fakeCcAdapter();
  ADAPTERS.commandcode = fake.adapter;
  const id = addRun("running");
  await begin(id);
  updateRun(id, { status: "paused" }); // UI pause: proc killed, handle left behind
  await abortRun(id, "carry on");
  expect(fake.turns).toHaveLength(2);
  expect(fake.turns[1]).toContain("carry on");
  expect(getRun(id)!.status).toBe("running"); // not paused
});

/** In-band-abort fake: liveSteer false but ONE session — its in-band abort surfaces a turn_end (SSE session.idle) during the abort+resume window. */
function fakeOcAdapter() {
  const sends: string[] = [];
  const adapter: Adapter = {
    caps: { liveSteer: false, abort: true, resume: true, oneProcPerTurn: false },
    async start(o: StartOpts): Promise<Handle> {
      return {
        pid: 424243,
        async send(text) { sends.push(text); },
        async abort() { o.onEvent({ type: "turn_end" }); },
        kill() {},
      };
    },
  };
  return { adapter, sends };
}

test("abort+resume leaves in-band-abort adapters alone: their own turn_end is not suppressed", async () => {
  const fake = fakeOcAdapter();
  ADAPTERS.commandcode = fake.adapter;
  const id = addRun("running");
  await begin(id);
  await abortRun(id, "pause a moment");
  expect(fake.sends).toContain("⛔ Interrupted by the manager:\npause a moment"); // resume turn still starts
  expect(fake.sends.some((s) => s.includes("factory_submit"))).toBe(true); // its turn_end reached the supervisor (nudge path), not fenced away
  expect(getRun(id)!.status).toBe("running");
});

/** Drives the real commandcode adapter (mcp spawns resolve instantly, turn spawns are controllable fakes). */
test("commandcode adapter: abort waits for the old turn to die and drops its superseded result", async () => {
  const realSpawn = Bun.spawn;
  const enc = new TextEncoder();
  const turns: { feed: (s: string) => void; exit: (code: number) => void; exitedSettled: () => boolean }[] = [];
  (Bun as any).spawn = (args: string[]) => {
    if (!args.includes("-p")) return { exited: Promise.resolve(0) }; // commandcode mcp add/remove
    const io = new TransformStream<Uint8Array, Uint8Array>();
    const writer = io.writable.getWriter();
    let settle = (code: number) => {};
    let settled = false;
    const exited = new Promise<number>((res) => (settle = (code) => { settled = true; res(code); }));
    turns.push({ feed: (s) => void writer.write(enc.encode(s)), exit: settle, exitedSettled: () => settled });
    return { pid: 0, exitCode: null, stdout: io.readable, stderr: new Blob([]).stream(), exited } as any; // pid 0: killTree no-ops
  };
  try {
    ADAPTERS.commandcode = real; // earlier tests swapped in their fake; this one drives the real adapter
    const ends: number[] = [];
    const texts: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "factory-cc-"));
    const handle = await ADAPTERS.commandcode.start({
      runId: "r-cc", role: "worker", cwd: dir, runDir: dir, prompt: "turn one", mcpUrl: "http://127.0.0.1:1/mcp", env: {},
      onEvent: (e) => { if (e.type === "turn_end") ends.push(1); if (e.type === "text") texts.push(e.text); },
    });
    expect(turns).toHaveLength(1); // mcp add/remove + initial turn
    const aborting = handle.abort();
    let abortDone = false;
    void aborting.then(() => (abortDone = true));
    await Bun.sleep(20);
    expect(abortDone).toBe(false); // abort() must not resolve while the old turn is still alive
    turns[0].exit(1);
    await aborting;
    expect(turns[0].exitedSettled()).toBe(true); // old turn fully stopped before anything resumes it

    await handle.send("resume text"); // starts the replacement turn
    expect(turns).toHaveLength(2);
    turns[0].feed(JSON.stringify({ type: "result", sessionId: "s1", finalText: "late result of the dead turn" }) + "\n");
    await Bun.sleep(20);
    expect(ends).toHaveLength(0); // superseded turn's late result must not reach onEvent
    turns[1].feed(JSON.stringify({ type: "result", sessionId: "s1", finalText: "resume done", usage: { inputTokens: 2, outputTokens: 3 } }) + "\n");
    for (let i = 0; i < 200 && !ends.length; i++) await Bun.sleep(10);
    expect(ends).toHaveLength(1); // and the replacement turn's own end still lands exactly once
    expect(texts).toEqual(["resume done"]);
  } finally {
    (Bun as any).spawn = realSpawn;
  }
});
