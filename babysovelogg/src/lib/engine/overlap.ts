// Phase 4 — twin overlap coupling (PURE). Reads the OUTPUTS of two independent
// per-baby engine runs and proposes at most ONE start-time nudge so the twins'
// sleep overlaps more (= simultaneous parent downtime). The per-baby learners
// are never coupled; this layer never mutates engine state. See
// docs/multi-child-phase4-design.md.
//
// Guardrails honoured here: suggestion-only, inside each baby's acceptable
// window (±1σ), start-time nudge only (never wakes a sleeping baby), bounded by
// one sleep cycle, and gated on a worthwhile overlap GAIN. The opt-in
// (isTwinMode && syncMode) and per-baby `blocked` flags are decided by the
// caller (getFamilyState) and passed in.

/** Minimum projected overlap GAIN (minutes) over the predict-independently
 *  baseline before a nudge is worth surfacing. (Odin: ≥30 min.) */
export const MIN_OVERLAP_GAIN_MIN = 30;

/** When two move-candidates tie within this many minutes of gain, the
 *  more-flexible (higher-variance / wider-window) baby is the one nudged, so the
 *  twin with the steadier, more-confident rhythm is disturbed least. (Odin:
 *  "the more-flexible/higher-confidence baby yields" — read as: don't move the
 *  predictable one.) */
const TIE_BREAK_MIN = 5;

export interface BabyWindow {
  babyId: number;
  /** The next actionable sleep the planner could nudge, with its expected
   *  duration. null when there's nothing to nudge (e.g. already asleep, or no
   *  prediction). */
  next: { kind: "nap" | "bedtime"; plannedStart: string; durationMin: number } | null;
  /** Acceptable start range (age- + confidence-bounded, ~±1σ). null → cannot
   *  bound the nudge, so this baby is never moved. */
  window: { earliest: string; latest: string } | null;
  /** Largest nudge allowed for this baby (≤ one sleep cycle for its age). */
  maxNudgeMin: number;
  /** When asleep: the projected wake (for overlap math). Never movable. */
  asleepUntil: { expected: string } | null;
  /** Prediction SD (minutes) — tie-break: the more-variable/flexible baby yields. */
  sdMinutes: number | null;
  /** Hard blocker: off-day, low confidence, stale/forgotten sleep, etc. */
  blocked: boolean;
}

export interface OverlapSuggestion {
  /** The baby to nudge (the more-flexible one). */
  babyId: number;
  /** Which sleep is being nudged — drives the logged sleep type on accept. */
  kind: "nap" | "bedtime";
  from: string;
  to: string;
  /** Signed nudge in minutes (within `window`). */
  deltaMin: number;
  /** Estimated simultaneous-sleep minutes after the nudge. */
  projectedOverlapMin: number;
  /** Estimated extra simultaneous-sleep minutes vs not nudging. */
  gainMin: number;
}

const ms = (iso: string) => new Date(iso).getTime();
const overlapMs = (aS: number, aE: number, bS: number, bE: number) =>
  Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));

/** A baby's CURRENT (un-nudged) sleep interval for overlap math: the remaining
 *  sleep if asleep, else its planned next sleep. null if neither exists. */
function plannedInterval(w: BabyWindow, now: number): { start: number; end: number } | null {
  if (w.asleepUntil) return { start: now, end: ms(w.asleepUntil.expected) };
  if (w.next) {
    const start = ms(w.next.plannedStart);
    return { start, end: start + w.next.durationMin * 60_000 };
  }
  return null;
}

/** Best in-window nudge for movable baby `m` so its next sleep overlaps the
 *  fixed interval `f` as much as possible. null when `m` can't be moved. */
function bestNudge(
  m: BabyWindow,
  f: { start: number; end: number },
  now: number,
): { start: number; overlap: number } | null {
  // Never move a sleeping baby (guardrail 4) or one we can't bound.
  if (m.asleepUntil || !m.next || !m.window) return null;
  const dur = m.next.durationMin * 60_000;
  const planned = ms(m.next.plannedStart);
  const lo = Math.max(ms(m.window.earliest), planned - m.maxNudgeMin * 60_000, now);
  const hi = Math.min(ms(m.window.latest), planned + m.maxNudgeMin * 60_000);
  if (hi < lo) return null;
  const clamp = (c: number) => Math.min(hi, Math.max(lo, c));
  // Candidate starts that can maximise a piecewise-linear overlap: align starts,
  // make m end at f's end, the window bounds, and the no-move baseline.
  const candidates = [planned, f.start, f.end - dur, lo, hi].map(clamp);
  let best = { start: planned, overlap: -1 };
  for (const c of candidates) {
    const ov = overlapMs(c, c + dur, f.start, f.end);
    if (ov > best.overlap) best = { start: c, overlap: ov };
  }
  return best;
}

/**
 * Given two babies' windows + now, return at most ONE overlap nudge, or null.
 * null when either baby is blocked, neither can be moved, or the best
 * achievable overlap gain is below MIN_OVERLAP_GAIN_MIN.
 */
export function suggestOverlap(
  a: BabyWindow,
  b: BabyWindow,
  now: number,
): OverlapSuggestion | null {
  if (a.blocked || b.blocked) return null;
  const ia = plannedInterval(a, now);
  const ib = plannedInterval(b, now);
  if (!ia || !ib) return null;
  const baseline = overlapMs(ia.start, ia.end, ib.start, ib.end);

  // Evaluate moving each baby against the OTHER's fixed (planned) interval.
  const moveA = bestNudge(a, ib, now);
  const moveB = bestNudge(b, ia, now);

  type Cand = { w: BabyWindow; res: { start: number; overlap: number }; gain: number };
  const cands: Cand[] = [];
  if (moveA) cands.push({ w: a, res: moveA, gain: moveA.overlap - baseline });
  if (moveB) cands.push({ w: b, res: moveB, gain: moveB.overlap - baseline });
  if (cands.length === 0) return null;

  // Highest gain wins; on a near-tie the more-flexible (larger SD / wider
  // window) baby yields, so the steadier twin's rhythm is disturbed least. SD
  // null = unknown variance → treated as most flexible, yields first.
  cands.sort((x, y) => {
    if (Math.abs(x.gain - y.gain) > TIE_BREAK_MIN * 60_000) return y.gain - x.gain;
    const sx = x.w.sdMinutes ?? Infinity;
    const sy = y.w.sdMinutes ?? Infinity;
    return sy - sx;
  });
  const pick = cands[0];

  const planned = ms(pick.w.next!.plannedStart);
  const deltaMin = Math.round((pick.res.start - planned) / 60_000);
  if (deltaMin === 0) return null;
  if (pick.gain < MIN_OVERLAP_GAIN_MIN * 60_000) return null;

  return {
    babyId: pick.w.babyId,
    kind: pick.w.next!.kind,
    from: pick.w.next!.plannedStart,
    to: new Date(pick.res.start).toISOString(),
    deltaMin,
    projectedOverlapMin: Math.round(pick.res.overlap / 60_000),
    gainMin: Math.round(pick.gain / 60_000),
  };
}
