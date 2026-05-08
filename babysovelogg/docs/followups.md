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

---

## Open bugs surfaced by the 2026-05-08 test-suite review

Codex + Opus reviewed the entire test suite after the engine-scenario sweep
shipped, reading snapshots critically for behavioural regressions baked in by
`--update`. Both reviewers converged on the same major findings — high
confidence each is a real engine bug.

### Engine bug: `target_bedtime` setting has no visible effect

**Where:** Settings sweep on Oskar — variants `target=18:00 (early)` AND
`target=21:00 (late)` both produce nearly identical bedtime values.

**Root cause** (Codex 2026-05-08 review): `selectBestPlan` clamps the
target to natural ±15 min via `DAILY_SHIFT_CAP_MS`
(`src/lib/engine/schedule.ts:1610-1615`). And the natural bedtime itself
goes through `recommendBedtime`'s sanity clamp first. So if natural lands
at 17:00 (e.g. via the new 17:00 floor), target=21:00 can only push to
17:15. The structural limit means target_bedtime is mostly cosmetic.

**Fix plan:** Lift `DAILY_SHIFT_CAP_MS` to something larger (60-90 min) so
the family's stated target can actually move bedtime. Document the cap
explicitly in the snapshot. Add a paired test: target=18:00 produces
*materially* earlier bedtime than target=21:00.

### Engine bug: B8 60-min filter checks `startTime`, should check `endTime`

**Where:** Eli at 12:30 active nap 3 has `predictedNaps: 16:16-17:01` with
`bedtime: 17:34` — only 33 minutes between nap end and bedtime, but B8 was
intended to ensure naps end well before bedtime. `tests/unit/engine-scenarios.unit.ts:1915-1929` shows the violation; the engine code at
`src/lib/engine/state.ts:567` filters on `n.startTime < bedtime - 60min`.

**Fix plan:** Change the B8 filter (and the matching invariant in the
sweep) to check `n.endTime` against bedtime. Pediatric rule should be on
how long after a nap ends bedtime is — not the start.

### Engine bug: emerging path lacks "collapsed to bedtime" cleanup

**Where:** Eli at 13:00 truncates `predictedNaps` to 3 entries but
`napsAllDone: false (4 expected)`. Same shape in plan-scoring.unit.ts:240-243.

**Hypothesis:** Routine path collapses to bedtime when remaining naps would
land within 60 min of bedtime; emerging path doesn't have the equivalent.

**Fix plan:** Port the routine collapse logic to `predictEmerging`.

### Engine bug: newborn `sleepWindow` is stale

**Where:** Nora at `now=07:00` shows `sleepWindow: 03:50–04:50` — the window
is in the past. `tests/unit/engine-scenarios.unit.ts:1690-1704`.

**Hypothesis:** Newborn `predictNewborn` anchors sleep window on historical
or default timing rather than the current wake context.

**Fix plan:** Compute sleepWindow from now-relative wake state, not from
fixed historical anchors. Add invariant: newborn `sleepWindow.earliest ≥
now − 15 min`.

### Suspicious backtest results: baby_5 with absurd MAE

**Where:** `tests/unit/backtest-multi.unit.ts:51-57` shows
`baby_5: 8 days, count 0% (0/4), nap MAE 134.3, dur MAE 55.2, bed MAE 1601.1, wake MAE 975`. 1601 minutes ≈ 26 hours; 975 minutes ≈ 16 hours. Same in
`ablation-multi.unit.ts:115-120` (`baby_5: nap 0, wake +104`).

**Hypothesis:** Date-boundary / timezone bug matching predictions against
the wrong day. Aggregate ablation thresholds are too lax to catch it.

**Fix plan:** Investigate `baby_5` fixture data; check tz normalization.
Probably needs labeled-fixture-skip or a real fix.

---

## Test infrastructure improvements (from the same review)

These are non-bug improvements both reviewers want:

- **Round float values in `renderPrediction`** — `ww=183.07692307692307m` is
  noise. Round to 1 decimal so a real shift stands out.
- **Extract `tests/helpers/baby-history.ts`** — `oneNapHistory`,
  `twoNapHistory`, `threeNapHistory`, `sparseHistory`, `newbornHistory`. The
  archetype builders in engine-scenarios are the canonical version; remove
  duplicates in `state.unit.ts:278` and `plan-scoring.unit.ts:46-81`.
- **Add `expectTimeNear(actual, expected, withinMin=5)` matcher** — for
  bug-pin tests like the May-7 floor where a 2-min engine improvement
  shouldn't cause test churn but a 30-min regression should.
- **ASCII vertical timeline renderer** — `renderTimeline(scn, p): string`
  rendering wake / predicted naps / now-marker / bedtime as a vertical
  timeline anchored on `now`. "nextNap is in the past" jumps out visually
  in diffs.
- **`renderSchedule(db): string` helper** — for
  `notification-scheduler.unit.ts` and `notifications.test.ts`. Currently
  every test re-queries `notification_schedule` inline.
- **Strict mode for `dismissSheet()`** in `tests/fixtures.ts:301-310` —
  currently swallows all failures, can hide broken modal behaviour.
- **One canonical `cleanAll(db)`** to replace the duplicate cleanup logic in
  `tests/integration/harness.ts:225` and `tests/fixtures.ts:109`.

## Test cleanup (lower priority, but flagged by both reviewers)

- `state.unit.ts:75-244` — fragment-style smoke tests on `assembleState`,
  largely subsumed by `engine-scenarios.unit.ts`. Delete or fold into the
  sweep.
- `state.unit.ts:304-792` — bug-pin regression tests (May-7, May-8, etc.)
  duplicated in the engine-scenarios paired-baseline section. Consolidate.
- `diaper-form-actions.unit.ts:15-46`, `event-view-utils.unit.ts:13-34`,
  `wake-sheet-actions.unit.ts:32-43`, `service-worker.unit.ts:11-67` —
  constants-restatement / single-field-per-test anti-patterns. Delete or
  collapse into table snapshots.
- `arc.e2e.ts:39-56`, `prediction.e2e.ts:175-203`, `bugs.e2e.ts:148-178` —
  E2E tests that assert "settings saved" or "arc visible" but not the
  prediction *effect*.

## Coverage gaps

- DST transition during a baby's day (Oslo spring/fall) through full
  `assembleState`. `dst.unit.ts` covers helpers; engine path is untested.
- `custom_nap_count` settings sweep (3→2 and 2→1 transitions across
  morning, post-nap, and skipped-nap states).
- Pause during active nap affecting `expectedNapEnd`.
- Strategy override (`StrategyOverride`) through `assembleState`.
- `nextNap` consistency across shuffled `todaySleeps` order (currently
  every test assumes prod's DESC ordering).
