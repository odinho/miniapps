# Followups

Tracked work that's ready to act on but not yet shipped. **This is the
durable todo list for this repo** — every agent should add to it when
something surfaces, and remove entries as units land. Don't reinvent
(no `TODO.md`, no `BACKLOG.md`, etc.).

Process rules — Codex pair-review, lateral-thinking checklist,
multi-day testing, the unit-of-work flow — live in
[`workflow.md`](./workflow.md). Don't put process in this file; this
is for tracked product/engine/test work.


## napBudget v2: manual sick / travel / off-day marker

Source: 2026-05-13 nap-cap design discussion. v1 of `napBudget` ships
with inference-only edge-case handling — when recent variance is high
(stdev/mean above a stability threshold), the budget recommendation
silently suppresses. Good enough most of the time, but:

- Doesn't help on the *first* sick day (the variance hasn't shown up yet).
- Travel/DST/timezone-shift days get judged on stale local-trend data
  for the whole window, when the parent already knows they're off-rhythm.
- Growth spurts are real but invisible to the engine.

Concrete v2: per-day "off day" toggle (sick / travel / spurt /
other) that (a) suppresses napBudget advisory for the day, (b)
optionally excludes the day from trend stats so it doesn't poison
future targets. UI: a small chip-style menu on the day's log entry
in `/logg` or the bottom of `+page.svelte`. Schema: new table
`day_marker(baby_id, date, kind, note)` or a column on `day_start`.
Notification scheduler should respect the same suppression.

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

## Docs: document wall-clock assumptions in the engine

Source: 2026-05-09 user question — "would this work on a spaceship?" The engine
currently assumes a conventional day/night schedule via several wall-clock anchors:

- `getHours()` for day-boundary logic (deep-night = 0-5am, evening = 18h+)
- `getLocalMinuteOfDay` throughout schedule scoring and habitual-anchor computation
- Bedtime habitual anchor assumes 17:00–23:00 range in plan scoring
- Night sleep typed as "night" for duration weighting (longest stretch = likely night)
- DST transition detection uses local time

A baby on an inverted schedule (bed 01:00, wake 12:00) would be misidentified as
"deep-night" during their active awake period and would have extremely high overtime
signals. The engine's "night sleep" concept is currently the longest sleep, but the
boundary logic would fight an inverted schedule.

Concrete documentation tasks:
1. Add a `## Wall-clock assumptions` section to `docs/agent-guide.md` listing the
   above anchors with file:line pointers.
2. Add a note to the user-facing README/settings about the conventional-schedule
   assumption and that unusual schedules may need the strategy to be set manually.

Long-term: habitual-wake / habitual-bedtime anchors are already learned per-baby —
if we track "longest sleep = night" without a hard hour boundary, the engine would
work on any schedule. The hour-gated logic in `timer-state.ts` (deep-night, evening)
is the main remaining assumption.

---

## Open bugs surfaced by the 2026-05-08 test-suite review

Codex + Opus reviewed the entire test suite after the engine-scenario sweep
shipped, reading snapshots critically for behavioural regressions baked in by
`--update`. Both reviewers converged on the same major findings — high
confidence each is a real engine bug.

### UX: infeasibility banner tested but not E2E-verified

`feasible` is now threaded from `SelectedPlan` through `Prediction` to Timer.svelte
(2026-05-09). The Timer shows "Målet ditt (HH:MM) er ikkje nåeleg i dag" in bedtime
mode when `feasible === false`, with the target time shown explicitly. No E2E test yet
covers the path: set target > engine max, verify the banner text appears. Low priority —
the engine logic is unit-tested; this is a display assertion.

### Backtest blind spot: target_bedtime data missing from Halldis fixture

`DayRecord` now has `target_bedtime?: string | null` and the backtest threads
it into `ctx.targetBedtime` (2026-05-09). But `tests/fixtures/halldis-sleep.json`
has no `target_bedtime` data (the feature didn't exist when the fixture was
exported). To actually measure whether the 60-min cap helps, re-export a fresh
Halldis fixture from prod that includes current target_bedtime settings, or
back-fill the field for known date ranges (e.g. target was ~19:30 from
approximately Halldis's 3-month mark).


### Engine: sleepWindow during active sleep shows "now" window, not post-wakeup window

Codex flagged (2026-05-09) during the sleepWindow staleness fix. When a
newborn/emerging baby is actively sleeping, `sleepWindow` is clamped to
near-now (invariant), but the semantically correct value would be the
expected next window _after this sleep ends_. `lastSleepEndMs` from
`assembleNewbornPrediction` / `assembleEmergingPrediction` takes the most
recent COMPLETED sleep, so the active sleep's predicted end time is not
used.

Low priority if the UI suppresses `sleepWindow` during active sleep. Verify
the UI doesn't show it, or fix by using the predicted wake time instead.

---

## Test infrastructure improvements (from the same review)

These are non-bug improvements both reviewers want:

- **Extract `tests/helpers/baby-history.ts`** — `oneNapHistory`,
  `twoNapHistory`, `threeNapHistory`, `sparseHistory`, `newbornHistory`. The
  archetype builders in engine-scenarios are the canonical version; remove
  duplicates in `state.unit.ts:278` and `plan-scoring.unit.ts:46-81`.
  Lower priority — each builder is only used in one file today; the bigger
  leverage is cleaning up state.unit.ts duplicates (separate followup),
  which would delete `rested1NapHistory` outright.
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
