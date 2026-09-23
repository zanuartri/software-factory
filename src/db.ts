import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.FACTORY_HOME ?? join(homedir(), ".factory");
export const PORT = Number(process.env.FACTORY_PORT ?? 4545);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
mkdirSync(HOME, { recursive: true });

export const db = new Database(join(HOME, "factory.db"), { create: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  coordinator TEXT, coordinator_seen INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, ws TEXT NOT NULL, ticket TEXT NOT NULL, role TEXT NOT NULL,
  harness TEXT NOT NULL, model TEXT, status TEXT NOT NULL, phase TEXT, pid INTEGER,
  session_id TEXT, worktree TEXT, branch TEXT, attempt INTEGER DEFAULT 1, parent TEXT,
  token TEXT NOT NULL, summary TEXT, tokens INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL, heartbeat_at INTEGER, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, ticket TEXT, run TEXT,
  type TEXT NOT NULL, data TEXT, for_coordinator INTEGER DEFAULT 0, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, ticket TEXT, run TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT, default_answer TEXT, irreversible INTEGER DEFAULT 0,
  deadline INTEGER, answer TEXT, answered_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, body TEXT NOT NULL,
  delivered INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ev_ws ON events(ws, id);
`);

export type Run = {
  id: string; ws: string; ticket: string; role: "worker" | "reviewer"; harness: Harness; model: string | null;
  status: "starting" | "running" | "idle" | "gating" | "done" | "failed" | "killed" | "paused";
  phase: string | null; pid: number | null; session_id: string | null; worktree: string | null; branch: string | null;
  attempt: number; parent: string | null; token: string; summary: string | null; tokens: number;
  started_at: number; heartbeat_at: number | null; ended_at: number | null;
};
export type Harness = "claude" | "pi" | "opencode" | "commandcode";
export type Workspace = { id: string; name: string; path: string; coordinator: string | null; coordinator_seen: number | null; created_at: number };

const listeners = new Set<(e: any) => void>();
export const onEvent = (fn: (e: any) => void) => (listeners.add(fn), () => listeners.delete(fn));

export function emit(ws: string, type: string, data: any = {}, opts: { ticket?: string; run?: string; coordinator?: boolean } = {}) {
  const ts = Date.now();
  const r = db.query("INSERT INTO events (ws,ticket,run,type,data,for_coordinator,ts) VALUES (?,?,?,?,?,?,?) RETURNING id")
    .get(ws, opts.ticket ?? null, opts.run ?? null, type, JSON.stringify(data), opts.coordinator ? 1 : 0, ts) as { id: number };
  const ev = { id: r.id, ws, ticket: opts.ticket, run: opts.run, type, data, for_coordinator: !!opts.coordinator, ts };
  for (const l of listeners) l(ev);
  return ev;
}

export const getRun = (id: string) => db.query("SELECT * FROM runs WHERE id=?").get(id) as Run | null;
export const updateRun = (id: string, patch: Partial<Run>) => {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.query(`UPDATE runs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...(keys.map((k) => (patch as any)[k]) as any[]), id);
};
export const getWs = (id: string) => db.query("SELECT * FROM workspaces WHERE id=?").get(id) as Workspace | null;
export const wsByPath = (p: string) => db.query("SELECT * FROM workspaces WHERE path=?").get(p) as Workspace | null;
