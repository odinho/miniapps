# Phase 4 — Twin scheduling intelligence (coupling) — DESIGN

**Status:** design pass (P4-0), 2026-06-14. Implementation (P4-1) is PARKED
pending Odin's approval of this design + the open decisions below.
**Owner doc:** [`multi-child-support.md`](./multi-child-support.md) §"Phase 4".

> This is the largest engine-adjacent change in the roadmap and the riskiest
> for the baby's experience. It is **opt-in, suggestion-only**, and must never
> degrade either baby's own sleep or the single-baby path. Nothing here ships
> until Odin signs off the design and the decisions in `local/loop-questions.md`.

## Goal

For **twins** (same-age, `isTwinMode`) whose parents opted into sync
(`family.syncMode`), help nudge the two babies toward **overlapping sleep** so
the parents get simultaneous downtime — "maximise overlapping parent-sleep
minutes", a target the singleton engine never had. The baby's own healthy sleep
stays the hard constraint; overlap is a bonus optimised *within* each baby's
acceptable window.

## Non-negotiable guardrails (from the plan)

1. **Opt-in, never default.** Predict-independently stays the baseline. Coupling
   only activates when `isTwinMode && family.syncMode` (X-12).
2. **Suggestion-only.** A *what-if* nudge the parent accepts or ignores — never
   an automatic schedule change, never a notification that fires an action.
3. **Inside each baby's acceptable window.** Never suggest a start/wake outside
   the age-appropriate, confidence-bounded window for that baby.
4. **Nudge, don't cap.** Prefer a small *start-time* nudge (put Bo down a little
   earlier/later) over a *wake cap* (waking a sleeping baby). The worst case to
   avoid is forcing Twin B awake because Twin A is ready.
5. **Parent policy, not natural evidence.** A nudge the parent accepts must NOT
   teach that baby's learner that the nudged time is the baby's natural rhythm.
6. **Never override** illness/off-day, an overtired state, or a low-confidence
   prediction. Sync yields to the baby's real needs every time.

## Architecture — a new PURE overlap layer; engine stays per-baby

`assembleState(ctx)` stays pure per-baby and **untouched**. The coupling is a
new pure module that reads the *outputs* of two independent per-baby runs and
proposes a nudge for ONE baby. The learners are never coupled.

```
src/lib/engine/overlap.ts  (new, pure)

interface BabyWindow {
  babyId: number;
  // The next actionable sleep the planner could nudge (nap or bedtime).
  next: { kind: "nap" | "bedtime"; plannedStart: string } | null;
  // Acceptable range for that start, age- + confidence-bounded (the engine
  // already computes WW/duration ranges + confidence; reuse them).
  window: { earliest: string; latest: string } | null;
  // Current state — an asleep baby's projected wake bounds (for overlap calc).
  asleepUntil: { earliest: string; expected: string; latest: string } | null;
  // Hard blockers: off-day, overtired, low-confidence, stale sleep.
  blocked: boolean;
}

interface OverlapSuggestion {
  babyId: number;                 // the baby to nudge (the more-flexible one)
  from: string; to: string;       // current planned start → suggested start
  deltaMin: number;               // signed nudge (within `window`)
  projectedOverlapMin: number;    // estimated simultaneous-sleep gain
  reason: string;                 // "Legg Bo 12 min tidlegare for ~42 min overlapp"
}

// Pure: given both windows + now, return at most ONE suggestion, or null.
// Returns null when either baby is blocked, sync is off, windows don't exist,
// or the best achievable overlap gain is below a threshold (not worth a nudge).
export function suggestOverlap(a: BabyWindow, b: BabyWindow, now: number): OverlapSuggestion | null
```

- Computed in `getFamilyState` (server) AFTER both `getBabyState` runs, attached
  as `family.overlapSuggestion` (null unless `isTwinMode && syncMode` and a
  worthwhile, in-window nudge exists). Client renders it as a what-if card.
- **Which baby yields:** nudge the one whose window most cheaply absorbs the
  delta (smaller `deltaMin` within-window, higher confidence). Never nudge a
  baby who is `blocked`. (Tie-break + max-delta = decisions for Odin.)
- **No wake nudges in v1** (guardrail 4) unless Odin opts in — start-time only.

## Parent-policy-not-evidence (guardrail 5) — the critical correctness piece

When the parent accepts a nudge and logs the resulting sleep, that sleep must be
excluded from (or down-weighted in) the baby's *learning* the same way the engine
already separates policy from evidence:
- The engine already has this pattern: `censorCutShortNaps` drops parent-ended
  short naps from the learnable pool; `woke_by` tags distinguish self-wake from
  parent-woken; trend classification separates policy-affected from natural days.
- **Proposal:** tag a nudge-accepted sleep at log time (e.g. an `onset` reason
  `synced` on `sleep.started`, analogous to the cap-respect `woke_by='woken'`
  tagging that already exists). Then:
  - duration/WW learning (`getLearnedNapDuration`, `getWakeWindow`, positional
    stats): treat a `synced` start like an off-day/policy sample — exclude or
    down-weight, NOT count as natural rhythm.
  - trend classification: a synced day is policy-affected, not natural.
- This needs a small schema addition (`sleep.started.onsetReason: "synced"` or a
  reuse of an existing field) + learner filters. It is the part most likely to
  silently corrupt the model if done wrong — so it gets its own unit + tests
  BEFORE the planner ships.

## What-if planner UX (suggestion-only)

- A dismissible card on the family home (twin-mode + syncMode only), e.g.
  "💡 Legg Bo ~12 min tidlegare (~13:18) for ~42 min felles søvn" with
  [Gjer det] / [Ikkje no]. [Gjer det] = optimistic `sleep.started` for Bo at the
  suggested time, tagged `synced`. [Ikkje no] dismisses for that window.
- Suppressed entirely when either baby is blocked (off-day/overtired/low-conf/
  stale), when sync is off, or when the overlap gain < threshold.
- Never a push notification in v1 (in-app only; co-sleep "wake the other" already
  set that precedent). Push de-noising is X-1, separate.

## Multi-day simulation test design

Following docs/workflow.md "Multi-day / over-time testing" + the existing
`backtest.ts` / `engine-scenarios.unit.ts` convergence patterns:
- **Harness:** a two-baby simulation. Seed two independent histories (twin-shaped,
  shared birthdate). Loop N days: assemble each baby's state, compute
  `suggestOverlap`, "accept" the suggestion per a policy (e.g. accept when
  deltaMin ≤ cap), append the resulting (tagged) sleeps, advance `now`.
- **Primary metric:** total **overlapping-sleep minutes per day** (both asleep).
  Assert it trends UP vs the predict-independently baseline over the week.
- **Guardrail invariants (must all hold):**
  - Neither baby's own daily sleep total / nap count degrades beyond a small
    tolerance vs baseline (no robbing-Peter).
  - No suggestion ever falls outside a baby's acceptable window.
  - A `blocked` baby (off-day/overtired/low-conf) receives no nudge.
  - **Learner cleanliness:** after a week of accepted nudges, the baby's *learned*
    natural WW/duration does NOT drift toward the nudged values (proves the
    policy-not-evidence tagging works) — the highest-value test.
  - **N=1 untouched:** a single-baby sim produces byte-identical predictions with
    the overlap layer present (it no-ops when <2 babies / syncMode off).
- Backtest fidelity caveat (from followups): the daily backtest replays
  `predictDayNaps`, not the full assembly path — the sim must run over
  `getFamilyState`/the planner, not just `predictDayNaps`.

## Decisions for Odin (do NOT guess — in local/loop-questions.md)

1. **Max nudge size** (per age band?) — e.g. ≤15 min? ≤1 cycle? Asymmetric
   earlier-vs-later (like the target_bedtime cap)?
2. **Whose schedule yields** — always the more-flexible/higher-confidence baby?
   The later one? Parent picks?
3. **Aggressiveness / overlap-gain threshold** — minimum projected overlap
   minutes to bother suggesting (avoid nag for a 5-min gain).
4. **Wake-side nudges** — v1 start-time only (recommended). Ever allow gently
   waking the first-to-wake to realign? (Guardrail 4 says avoid; confirm.)
5. **"Acceptable window" definition** — derive from the engine's existing
   confidence ranges (±1σ?) or a fixed age-band tolerance?
6. **Accept UX** — does [Gjer det] log the sleep immediately, or just pre-fill
   the time on the next manual log? (Cardinal invariant: must be unmistakably Bo.)

## Codex architecture review (P4-0)

Codex did a read-only architecture pass (its run captured exploration leads; the
wrapper truncated the final summary, so this synthesises the captured findings —
all of which CONFIRM this design and sharpen two points):

- **Boundary is right.** The roadmap already draws a strong boundary — per-baby
  engine stays pure, coupling is an explicit separate layer. The proposed pure
  `overlap.ts` reading two independent per-baby outputs (never coupling the
  learners) matches that.
- **`woke_by` precedent exists but is NOT sufficient.** `woke_by` is carried into
  engine inputs and protects the duration/cap paths, but it does **not** shield
  WW/trend learning. So the "parent policy, not natural evidence" guardrail needs
  a **distinct marker for synced sleeps** (not a reuse of `woke_by`), wired into
  the WW/positional and trend learners specifically. This is the highest-risk
  correctness piece — confirmed it gets its own unit + the learner-cleanliness
  simulation invariant before the planner ships.
- **No first-class "acceptable window" API exists yet.** The schedule engine has
  confidence ranges + WW/duration stats but no single "acceptable start window"
  object. Phase 4 must introduce `BabyWindow.window` deliberately (decision #5 —
  derive from existing confidence ranges vs a fixed age tolerance).
- **Event schema gap.** `sleep.started` currently carries only
  `babyId`/`startTime`/`type`/`sleepDomainId` — a small schema addition is needed
  to tag a synced (nudge-accepted) onset. Mirror the existing tag-on-write
  pattern; keep replay-compat.
- **The sync-mode UI copy already promises overlapping sleep** ("Samkøyr dagen …
  siktar mot overlappande søvn"). Expectation is set — Phase 4 must actually
  deliver it, or the toggle stays a no-op (the P2-7/Dagsrytme product call).

No architectural objection to the design; the guardrails stand. The above are
sharpenings, not changes.
