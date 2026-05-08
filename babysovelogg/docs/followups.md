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

## Comprehensive engine-scenario test sweep

Source: 2026-05-08 user feedback after the *fifth* prediction-engine bug
in a week reached prod. Specific bug: skipped synthetic comeback dragged
bedtime to 19:22 (vs ~17:30 expected). Pattern: every fix has been a
post-hoc regression test for one bug, never a category-spanning sweep
that would catch the *next* bug before it ships.

Quoting the user: *"If I'd written them, they'd be high level and have
stats from a few made up babies and with a lot of scenarios for each of
them and seeing how that plays out at different ages and with different
times."*

**Goal:** one new file, `tests/unit/engine-scenarios.unit.ts`, that
sweeps `assembleState()` across a small set of synthetic babies × a wide
set of "current-state" inputs, snapshotting the full Prediction render
and pinning universal invariants that can't be `--update`-pasted away.

### Synthetic babies (4–6 archetypes covering the strategy space)

Each archetype sets up a `Baby` row + 14–21 days of synthetic history
that lands the strategy selector exactly where we want it. Suggested
starting set:

1. **`newborn-3mo`** — strategy `newborn_guidance`. No schedule, no
   target. Verifies sleep-window mode renders sanely.
2. **`emerging-5mo`** — strategy `emerging_rhythm`. 4 short naps, no
   target. Verifies the adapter between newborn and schedule.
3. **`twonap-8mo-no-target`** — `routine_schedule`, 2-nap, no target,
   ~14 days of consistent 09:30 + 13:30 naps and 19:00 bedtime.
4. **`onenap-10mo-target-18`** — Halldis-shape: `routine_schedule`,
   1-nap, target 18:00, learned 108-min nap, bedtime ~18:30.
5. **`transition-13mo`** — `routine_schedule`, oscillating 1↔2 nap
   (transition-filter exercised).
6. **`toddler-15mo`** — `routine_schedule`, 1-nap late (~13:00), no
   target.

### Scenario axis

Sweep each baby through these "current-state" inputs:

- **Times of day**: 06:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:30
  local — covers pre-nap, post-nap, late-afternoon, pre-bedtime,
  post-bedtime.
- **Today's sleep state**: pristine; mid-active-nap; one full nap done;
  one cut-short done (woke_by="woken"); two cut-shorts; one full +
  one cut-short; missed-nap (predicted overdue 90+ min); active-night.

That's roughly 7 × 8 = 56 scenarios per baby, ~300 total at 5 babies.
Skip combinations that don't make sense (e.g. active-nap at 06:00) and
the matrix collapses to ~150.

### Render shape

A compact human-readable string per scenario, snapshotted inline:

```
strategy: routine_schedule (Tilpassa)
expectedNapCount: 1, napsAllDone: false
nextNap: 11:00 ±15m
bedtime: 18:00 ±20m
predictedNaps: 11:00–12:48
expectedNapEnd: —
rescueNap: —
continuationWindow: —
learned: nap=108m, bedtimeWW=345m, cycle=55m
```

### Pinned invariants (apply to every scenario, not just the snapshot)

These are the things that have *all* been violated by recent regressions
and must be checked unconditionally:

- `bedtime` (if non-null) is on the *local date implied by the wake
  reference* — not next-day.
- `bedtime` hour ∈ [16:00, 23:00] in baby's local TZ.
- `nextNap` (if not equal to `bedtime`) is in the future relative to
  `now`, with at most 90 min grace for the napSkipped path.
- `predictedNaps[i].startTime > predictedNaps[i-1].startTime`.
- No `predictedNaps[i].endTime > bedtime - 60 min`.
- When `napsAllDone === true`, `predictedNaps === null`.
- `continuationWindow.closesAt > now`.
- No NaN, no negative durations, all ISO timestamps parse.

### Layering with existing tests

- **Keep `duration-prediction.unit.ts`** — fixture-backtest measures
  historical accuracy on Halldis. Different question.
- **Keep `learned-duration-scenarios.unit.ts`** — duration-learning
  table, unrelated to runtime prediction shape.
- **Migrate from `state.unit.ts`**: the 28 tests there are mostly
  bug-specific regressions. Once the scenario sweep covers their
  surface area, leave them in place as targeted pins (each commit
  message reference) but expect the sweep to be the primary line of
  defence going forward.
- **Keep `plan-scoring.unit.ts`** — that's about scoring internals.

### Implementation notes

- Heavy use of helper builders so each scenario row is one line:
  `scenario("11:00", { naps: [["08:00", "08:28", "woken"]] })` etc.
- Inline snapshots, but invariants run *before* the snapshot so a
  `--update` can't paste over a broken state.
- Codex consulted on shape (see ai-pair-review thread 2026-05-08); his
  input was the cleanest version: keep the matrix small and dense, not
  a sparse mountain of tests no-one reads.
