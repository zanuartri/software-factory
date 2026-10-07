export function firstLoadOutcome(mine: number, current: number, first: boolean, failed: boolean): "stale" | "failed" | "loaded" {
  if (mine !== current || !first) return "stale";
  return failed ? "failed" : "loaded";
}
