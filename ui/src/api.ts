import { useCallback, useEffect, useRef, useState } from "react";

export type Harness = "claude" | "omp" | "commandcode";
export type Ticket = {
  id: string; title: string; status: "draft" | "open" | "in_progress" | "in_review" | "done"; priority: string;
  tags: string[]; depends_on: string[]; scope_paths: string[]; harness: Harness | "any"; model: string;
  blocked?: string | null; failed?: string | null; issue?: string | null; branch?: string | null; attempts?: number;
  sections: Record<string, string>; brief_errors: string[]; runs?: Run[];
  /** latest worker run (daemon-attached); what a harness:any ticket actually ran on */
  run?: { harness: Harness; model: string | null } | null;
};
/** HarnessTag props: a harness:any ticket that has run shows the real harness/model; a pinned one keeps its pin (with `model` if given). */
export const harnessOf = (t: Ticket, model?: string | null) => t.harness === "any" && t.run ? { h: t.run.harness, model: t.run.model } : { h: t.harness, model };
export type Run = {
  id: string; ws: string; ticket: string; role: "worker" | "reviewer"; harness: Harness; model: string | null;
  status: string; phase: string | null; attempt: number; summary: string | null; tokens: number; parent: string | null;
  started_at: number; heartbeat_at: number | null; ended_at: number | null; session_id: string | null;
};
export type FEvent = { id: number; ws: string; ticket?: string; run?: string; type: string; data: any; ts: number; for_manager?: boolean | number };
export type Ask = { id: number; ws: string; ticket: string; run: string; question: string; options: string; default_answer: string; irreversible: number; answer: string | null; answered_by: string | null; created_at: number; deadline: number };
export type Issue = { id: string; title: string; status: string; kind: string; tags: string[]; tickets: string[]; body: string; reason?: string | null; created: string };
export type Models = Record<Harness, { id: string; hint?: string }[]>;
export type ReviewerPick = { harness: Harness | "auto"; model: string };
export type Settings = { cost_routing: boolean };
export type Workspace = { id: string; name: string; path: string; manager: string | null; manager_seen: number | null; settings: any; plan: any; counts?: Record<string, number> };

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown; text?: boolean; timeout?: number }): Promise<T> {
  const method = init?.method ?? (init?.body !== undefined ? "POST" : "GET");
  const timeout = init?.timeout ?? (method.toUpperCase() === "GET" ? 10000 : 0);
  const ac = new AbortController();
  const timer = timeout === 0 ? undefined : setTimeout(() => ac.abort(), timeout); // a hung GET must reject so callers (chat poll inflight) can reset
  try {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      signal: ac.signal,
    });
    if (init?.text) return (await res.text()) as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data });
    return data;
  } finally { clearTimeout(timer); }
}

// ---- live bus: one WebSocket, many listeners
type L = (e: FEvent) => void;
const listeners = new Set<L>();
let socket: WebSocket | null = null;
let connected = false;
const connListeners = new Set<(c: boolean) => void>();
function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`);
  socket.onopen = () => { connected = true; connListeners.forEach((f) => f(true)); };
  socket.onmessage = (m) => { const e = JSON.parse(m.data); listeners.forEach((l) => l(e)); };
  socket.onclose = () => { connected = false; connListeners.forEach((f) => f(false)); setTimeout(connect, 1500); };
}
connect();
export function useLive(fn: L) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => { const l: L = (e) => ref.current(e); listeners.add(l); return () => void listeners.delete(l); }, []);
}
export function useConnected() {
  const [c, set] = useState(connected);
  useEffect(() => { connListeners.add(set); set(connected); return () => void connListeners.delete(set); }, []); // open may fire between render and subscribe
  return c;
}

/** GET + refetch whenever a live event for this workspace passes `when` (throttled). */
export function useApi<T>(path: string | null, when: (e: FEvent) => boolean = () => true, text = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    api<T>(path, { text }).then((d) => { if (mine === seq.current) { setData(d); setError(null); } }).catch((e) => { if (mine === seq.current) setError(e.message); });
  }, [path, text]);
  useEffect(() => { setData(null); load(); return () => clearTimeout(timer.current); }, [load]);
  useEffect(() => { // daemon came back: refetch, since events emitted while we were offline are gone
    const f = (c: boolean) => { if (c) load(); };
    connListeners.add(f);
    return () => void connListeners.delete(f);
  }, [load]);
  useLive((e) => {
    if (!when(e)) return;
    if (timer.current !== undefined) return; // throttle: the first event of a burst schedules the refetch, later ones ride it
    timer.current = setTimeout(() => { timer.current = undefined; load(); }, 300);
  });
  return { data, error, reload: load };
}

export const ago = (ts?: number | null) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
};
export const LIVE = ["starting", "running", "idle", "gating", "paused"];
