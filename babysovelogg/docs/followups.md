# Followups

Tracked work to fix soon. Don't let this list grow.

## Flaky E2E: `dashboard.e2e.ts:165` — Redirects to settings when no baby exists

**Status:** confirmed pre-existing (fails on plain `main` HEAD; reproduces with
`bun run test:e2e tests/dashboard.e2e.ts` — passes solo).

**What it does:** navigates to `/`, expects the `Velkomen til Babysovelogg`
heading to be visible. The fixture's [`autoResetDb`](../tests/fixtures.ts) is
supposed to clear `baby` so the redirect-to-settings flow fires, but when this
test runs after other tests in the file (which create babies), the assertion
times out at the heading lookup — implying state from a prior test bleeds in,
likely via a race between the optimistic in-flight `POST /api/events` and the
fixture's reset, or a shared SSE stream that's still emitting state with a baby
attached.

**Plan:**
1. Add `await page.waitForLoadState("networkidle")` after `page.goto("/")` to
   let any in-flight SSE state from prior tests settle, then re-assert.
2. If still flaky, make `resetDb()` synchronous via a dedicated test endpoint
   that closes broadcast channels before clearing tables, instead of relying on
   raw SQL deletes that race with open SSE connections.
3. Pin: run the full `dashboard.e2e.ts` 5 times in a row in CI as a smoke
   check — if it passes 5/5 it's stable.

**Impact:** low — production is unaffected; the test exercises onboarding and
this scenario is well-covered elsewhere. But "no flakiness allowed" is the
project rule.

## UI: render the nap-confidence band on the arc

Source: 2026-05-07 user feedback after Halldis fell asleep at 12:05 vs
predicted 11:34 (±15 min text only). The ±N min figure is in the timer
center but doesn't translate to a feel for "how soft is the prediction". A
faded uncertainty band around the predicted-nap arc would make it visually
obvious. Should map directly off `prediction.confidence.napRanges[0].lo/hi`
which we already compute.

Sketch: in `Arc.svelte`, when there's a `confidence.napRanges[0]`, render
an extra translucent band beneath the existing predicted-nap band, spanning
`lo → hi`. Keep colour sympathetic to the day theme. Do not overlap the
cut-short bubble or the active-sleep arc.

## UX: "give up and try later" guidance after sticking too long

Source: same 2026-05-07 conversation. User's pattern: they sometimes spend
25+ min trying for a nap that won't come, tiring both parent and baby. The
engine could surface a "try again in 20 min" suggestion when there's been
no active sleep N minutes past the predicted window.

Concrete: when `awakeMs > nextNap + (configurable threshold, e.g. 20 min)`
and no active sleep, show a banner "Vurder å gi seg og prøve igjen om
~20 min — fortsett ikkje viss begge blir slitne". Ties into the existing
overdue logic but is more directive. Consider making the threshold a
per-baby setting tuned to historical fall-asleep latency.

## Comprehensive engine-scenario test sweep — DELIVERED

Source: 2026-05-08 user feedback after the *fifth* prediction-engine bug
in a week reached prod. Specific bug: skipped synthetic comeback dragged
bedtime to 19:22 (vs ~17:30 expected). Pattern: every fix has been a
post-hoc regression test for one bug, never a category-spanning sweep
that would catch the *next* bug before it ships.

**Status (2026-05-08):** shipped as `tests/unit/engine-scenarios.unit.ts`.
6 archetypes (Nora newborn, Eli emerging, Mina 3-nap, Oskar 1-nap, Ada
no-target, Iben sparse), ~80 scenarios, ~12 universal invariants applied
before snapshot, paired-baseline tests for May-7 floor, May-7 22h-17m,
May-8 19:22 bugs. Settings dimension (Oskar × target_bedtime). Cross-
archetype shared scenarios with per-strategy `expect`/`skipFor` for N/A
handling. Codex pair-reviewed at architecture and final-pass stages.

Concurrent engine fix: `buildContext` and `recommendBedtime` now thread
`now` through the wall-clock-using spots (`calculateAgeMonths` and the
synthetic-penalty / target-bedtime fallbacks), so the engine is fully
deterministic when `data.now` is supplied. Original test-suite plan
follows for reference of what the spec was.

Quoting the user: *"If I'd written them, they'd be high level and have
stats from a few made up babies and with a lot of scenarios for each of
them and seeing how that plays out at different ages and with different
times."*

**Goal:** one new file, `tests/unit/engine-scenarios.unit.ts`, that
sweeps `assembleState()` across a small set of synthetic babies × a wide
set of "current-state" inputs, snapshotting the full Prediction render
and pinning universal invariants that can't be `--update`-pasted away.

### Synthetic babies (6 archetypes covering the strategy space)

Each archetype is a `Baby` row + a synthetic history that lands the
strategy selector deterministically. Birthdates anchored on a fixed
"today" so age is stable. Final names/dates to be confirmed at impl
time, but the shape is:

1. **Nora Newborn** — strategy `newborn_guidance`, 5-7 naps, unstable
   wake windows, target ~20:30, 5 days of noisy logging. No reliable
   learnedSchedule. Verifies sleep-window rendering.
2. **Eli Emerging** — strategy `emerging_rhythm`, 4 naps, occasional
   rescue, target 19:45, 21 days. Short first naps, improving afternoon.
   Verifies the newborn↔schedule adapter.
3. **Mina Learned** — strategy `routine_schedule`, 3 naps, target 19:15,
   45 days of consistent timing/duration. Strong learnedSchedule —
   predictions should be tight.
4. **Oskar OneNap** — `routine_schedule`, 1 nap, target 19:30, 60 days
   of long midday nap. The Halldis-shape; primary surface for skipped-
   comeback / cut-short recovery scenarios.
5. **Ada NoTarget** — `routine_schedule`, 2 naps, `target_bedtime: null`
   (deliberately removed), 30 days of normal history. Verifies engine
   doesn't crash or default poorly when target is unset.
6. **Iben Sparse** — 3-4 naps, target 20:00, 6 scattered days with
   gaps and partial logs. Stress-tests null-ish inputs and missing data.

### Scenario axis

Sweep each baby through these inputs:

- **Now buckets**: 06:00, 08:30, 11:30, 14:30, 17:30, 19:00, 21:30 local
  — pre-nap, just-woke, late-afternoon, pre-bedtime, post-bedtime.
- **Today's sleep state**: pristine; in active nap; just woke; one full
  nap done; all naps done; missed/skipped expected nap.
- **Cut-short variants**: 5m, 20m, 35m, 55m durations × comeback timing
  at +0m, +60m, +2h18m, +2h45m, +3h15m from cut-short end. The recent
  regressions all live in this sub-matrix.
- **Continuation-window states**: open, closed/dismissed, expired,
  overlapping rescueNap candidate.
- **Synthetic/comeback states**: accepted, skipped, still pending —
  explicitly assert skipped synthetic comeback does not pull bedtime
  earlier than the no-comeback baseline (the May-8 19:22 bug).
- **Missing data**: no target_bedtime, null learned inputs, empty day,
  malformed partial nap, future nap.
- **Age boundary sweeps**: shift fixture birthdate ±7 days around
  regime thresholds (3-mo, 6-mo, 9-mo, 12-mo, 18-mo) to confirm
  transition behaviour.

### Render shape

One snapshot block per baby × scenario. Stable ordering, local `HH:MM`
times, `+Xh Ym` deltas, `none` for absent values:

```
baby: Mina Learned
scenario: cut-short-third-nap-now-16:37
now: 16:37
inputs: naps=today[08:50-09:28, 12:11-13:24, 15:58-16:12], target=19:15
prediction:
  nextNap: 18:57 (+2h20m)
  bedtime: 19:45 (+3h08m)
  predictedNaps: [08:50-09:35, 12:10-13:20, 15:55-16:40, 18:57-19:17]
  napsAllDone: false
  expectedNapEnd: 16:40
  rescueNap: true
  continuationWindow: false
  learnedSchedule: 3-nap, confidence=high
```

### Pinned invariants (apply to every scenario, not just the snapshot)

Run these *before* the snapshot compare so a `--update` can't paste
over a broken state. These are the contracts every recent regression
violated:

1. No rendered Prediction value contains `NaN`, `Invalid Date`, `null`,
   or `undefined` where a value is expected.
2. `bedtime` is on today's local date — never "tomorrow because of
   overflow" (the May-7 22h-17m bug).
3. `bedtime` is within 18h of `now`; clamp violations fail before
   snapshot compare.
4. If `rescueNap` follows a cut-short, `nextNap` is never earlier than
   `cutShort.end + 2h45m` unless fixture is in newborn strategy (the
   May-7 11:07 floor bug).
5. A closed `continuationWindow` must render `false` and stay false
   for the rest of the scenario — no banner staleness.
6. **Skipped comeback / synthetic nap must not pull `bedtime` earlier
   or later than the no-comeback baseline** (the May-8 19:22 bug).
7. `napsAllDone: true` implies `nextNap: none` AND `rescueNap: false`.
8. `expectedNapEnd` cannot be before `now` for an active-nap scenario.
9. `predictedNaps` are chronological and non-overlapping.
10. Missing `target_bedtime` must still produce a finite `bedtime` or
    a deliberate `none` — never crashy output.
11. `continuationWindow` and `rescueNap` cannot advertise contradictory
    actions for the same nap unless explicitly intended and labeled.

### Layering with existing tests

- **Single file**: `tests/unit/engine-scenarios.unit.ts`. Don't split
  per-strategy — these are *cross-strategy behavioural contracts* for
  `assembleState()`; splitting hides regressions caused by interactions
  between `learnedSchedule`, `rescueNap`, `continuationWindow`,
  `bedtime`, and `predictedNaps`.
- **Absorb most of `state.unit.ts`**: the 28 tests there are mostly
  bug-specific. Once the sweep covers their surface, leave them as
  targeted pins (each linked to a commit message reference) but expect
  the sweep to be the primary defence going forward.
- **Keep `duration-prediction.unit.ts`** — historical accuracy backtest
  on Halldis is a different question (regression on real data vs.
  contract correctness).
- **Keep `learned-duration-scenarios.unit.ts`** — duration-learning
  table is unrelated to runtime prediction shape.
- **Keep `plan-scoring.unit.ts`** — scoring internals.
- **Keep small focused unit tests** only for pure helpers where failure
  diagnosis through `assembleState()` would be noisy.

### Implementation notes

- Heavy helper builders so each scenario row is one line:
  `scenario("11:00", { naps: [["08:00", "08:28", "woken"]] })`.
- Invariants run **before** snapshot compare so `--update` can't paste
  a violation away.
- Aim for ~150 scenarios total once invalid combinations (active-nap
  at 06:00, etc.) collapse.
- Codex pair-reviewed the design (2026-05-08 thread) — converged on
  the structure above.
