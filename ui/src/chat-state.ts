export type QueuedClaim = { text: string; after: string | null };
export type PendingMessage = { key: string; text: string; after: string | null; claimed?: string[]; queuedClaims?: QueuedClaim[] };
export type TranscriptMessage = { id: string; role: string; text: string };

export function reconcilePending<P extends PendingMessage>(pending: P[], messages: TranscriptMessage[], queued: string[]): P[] {
  const users = messages.filter((m) => m.role === "user"), claimed = new Set(pending[0]?.claimed ?? []);
  const queuedClaims = [...(pending[0]?.queuedClaims ?? [])], queueCounts = new Map<string, number>();
  for (const text of queued) { const key = text.trim(); queueCounts.set(key, (queueCounts.get(key) ?? 0) + 1); }
  const waiting: QueuedClaim[] = [];
  for (const claim of queuedClaims) {
    const count = queueCounts.get(claim.text) ?? 0;
    if (count) { queueCounts.set(claim.text, count - 1); waiting.push(claim); continue; }
    const anchor = claim.after ? users.findIndex((m) => m.id === claim.after) : -1;
    const match = users.find((m, i) => (anchor < 0 || i > anchor) && !claimed.has(m.id) && m.text.trim() === claim.text);
    if (match) claimed.add(match.id);
    else waiting.push(claim);
  }
  let changed = false;
  const remaining: P[] = [];
  for (const p of pending) {
    const text = p.text.trim(), count = queueCounts.get(text) ?? 0;
    if (count) {
      queueCounts.set(text, count - 1);
      waiting.push({ text, after: p.after });
      changed = true;
      continue;
    }
    const anchor = p.after ? users.findIndex((m) => m.id === p.after) : -1;
    const match = users.find((m, i) => (anchor < 0 || i > anchor) && !claimed.has(m.id) && m.text.trim() === text);
    if (match) { claimed.add(match.id); changed = true; continue; }
    remaining.push(p);
  }
  const ids = [...claimed], remainingWithClaims = remaining.map((p) => {
    const hasClaimedChange = ids.length !== (p.claimed?.length ?? 0) || ids.some((id, i) => id !== p.claimed?.[i]);
    const hasQueuedChange = waiting.length !== (p.queuedClaims?.length ?? 0) || waiting.some((claim, i) => claim.text !== p.queuedClaims?.[i].text || claim.after !== p.queuedClaims?.[i].after);
    return hasClaimedChange || hasQueuedChange ? { ...p, claimed: ids, queuedClaims: [...waiting] } as P : p;
  });
  return changed || remainingWithClaims.some((p, i) => p !== remaining[i]) ? remainingWithClaims : pending;
}
