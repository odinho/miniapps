// Last-writer-wins guard for state applies. Every server snapshot carries a
// monotonic `revision` (the max applied event id). A slow /api/state response
// computed before a newer event must NOT clobber a fresher event-response/SSE
// that already landed — so we drop a strictly-older revision.

/**
 * Whether to apply an incoming state given the last-applied server revision.
 * - `revision` 0/undefined is never gated (the empty state, or a per-baby
 *   slice that carries no family revision) — always apply.
 * - Same-or-newer revision applies (a re-fetch at the same revision is
 *   idempotent; optimistic updates keep the base revision so they apply).
 * - A strictly-older revision is dropped (the stale-response race).
 */
export function shouldApplyRevision(
  incomingRev: number | undefined,
  appliedRev: number,
): boolean {
  if (!incomingRev) return true;
  return incomingRev >= appliedRev;
}
