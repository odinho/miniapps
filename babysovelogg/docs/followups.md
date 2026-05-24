# Followups

Tracked work that's ready to act on but not yet shipped. **This is the
durable todo list for this repo** — every agent should add to it when
something surfaces, and remove entries as units land. Don't reinvent
(no `TODO.md`, no `BACKLOG.md`, etc.).

Process rules — Codex pair-review, lateral-thinking checklist,
multi-day testing, the unit-of-work flow — live in
[`workflow.md`](./workflow.md). Don't put process in this file; this
is for tracked product/engine/test work.

## Pause UX redesign — see dedicated plan

Source: 2026-05-22 design pass with Codex pair-review. Plan lives in
[`pause-redesign-2026-05-22.md`](./pause-redesign-2026-05-22.md).
Staged rollout replaces the single `Pause` button with (a) reversible
`End` for naps and (b) first-class `night_waking` events with their
own edit sheet, arc rendering, and history rows. `sleep_pauses` table
and `sleep.paused`/`sleep.resumed` events go away at stage 4.

Stage 1 (Angre slutt button in WakeUpSheet/EditSleepModal) shipped
2026-05-24 — reuses the existing `sleep.restarted` event the post-End
undo toast already emitted. No schema change.

Stages still pending: 2 (`night_waking` table + events + projections),
3 (night-waking UI + arc red sub-bands + edit sheet + history rows),
4 (remove pause-on-naps + drop `sleep_pauses` + simplifications), 5
(polish).


## Trend intervention-target split — stage 5+ followups

Source: 2026-05-20 design pass + four-stage implementation (commits
`b9b0161` → `3691db3`). Stages 1–4 shipped: held intervention target
with anti-ratchet drift, persistence in `trend_target_state` table,
`computeNapBudget` + `censorCutShortNaps` cap-respect wired to the
intervention number, `isDayOnTrend` deliberately left on observed
for rescue/continuation. Closed-loop test passes (30 days of
cap-following → target drift ≤ 15 min, observed drops materially).
Migration: `CREATE TABLE IF NOT EXISTS` runs on schema init; first
`/api/state` call after deploy seeds the row from `max(observed,
natural-day mean of last 30)` and persists it. No manual migration.

Remaining items, in priority order:

- **Drift epoch gate is time-based, not data-based.** Currently
  same UTC date as `prior.updatedAt` → no-op. A data-based gate
  (`evaluatedThroughDate` / fingerprint of the latest classified
  completed day) would also catch "same date but parent logged a
  self-wake nap that satisfied the streak". `src/lib/engine/trend.ts`
  `evaluateTrendTargetDrift` epoch check.

- **Policy classifier uses observed as the near-target reference.**
  Held target and observed diverge once cap-following begins; the
  classifier still uses observed for the "near target" check. Under
  target-5+jitter this lines up; if/when we switch the reference to
  the held target without explicit cap-event attribution, the
  classification becomes circular. Real fix: log a `nap_budget_event`
  row when the cap fires and the parent acts on it, then classify
  policy-affected from explicit attribution.
  `src/lib/engine/trend.ts` `classifyTrendDay`.

- **UI / API copy still labels observed-trend as "Trendmål".**
  `dailyTrendTotalMin` is preserved for one release as
  `observedRecentMin`; the napBudget banner's `context.blendedTrendMin`
  now ships intervention; stats UI labels need a sweep so "Trendmål"
  consistently means the intervention target wherever it's a target,
  and "Snitt siste 7d/30d" wherever it's a stat. Audit:
  `src/routes/+page.svelte` (banner), `src/routes/stats/+page.svelte`,
  `src/lib/stores/app.svelte.ts:103-111` (the field comment).

- **Backtest harness doesn't replay `TrendTargetState`.**
  `src/lib/engine/backtest.ts` keeps using observed via the
  `computeTrendTotalMin` wrapper — correct for "what would an
  unattended observer predict?" but wrong for "did the held target
  improve outcomes?". A stateful replay that carries
  `TrendTargetState` across days would let us measure intervention-
  target performance against history.

- **Low-confidence firm caps.** A `firm` urgency cap can fire from
  a low-confidence held target (Codex stage-4 review flagged it as a
  product decision rather than a bug). If we want confidence to gate
  urgency, cap low-confidence napBudget at `advisory` in
  `src/lib/engine/nap-budget.ts` near the urgency calc.

- **`state.source` / `state.confidence` semantics loose.**
  `source` stays `"observed-initial"` even after upward natural
  drift (only downward sets `"natural-days"`). `confidence: "high"`
  is currently unreachable. Acceptable while the diagnostics aren't
  user-facing; tighten when they surface.

- **Sleep-day bucketing replacement of off-day expansion.** Codex
  flags the current calendar-day start-anchored bucketing +
  symmetric off-day expansion (drop date + previous date) as
  imprecise. The cleaner shape: trend bucketing follows sleep-days
  (overnight ending on the morning belongs to that sleep-day),
  off-day exclusion becomes single-day. Bigger refactor; pin only
  when the imprecision causes a visible miss.

## Adaptation layer — long-term ideas (parked, not yet planned)

Source: 2026-05-20 Codex adaptation pass. Big-picture architecture
ideas that exceed the scope of any single in-flight followup. Park
here so they're available when we next touch the relevant code.
None are urgent; capture for future reference.

- **Sample reliability mass instead of sample count.** Today the
  engine treats every completed sleep as one observation. Reality:
  a self-woke clean nap, a parent-woken cap, an imported Napper
  inferred night, and a fragmented sick-day night are all
  different-quality observations. A `sampleReliability(s, feature)`
  helper that returns a per-feature weight (duration learning vs
  wake-window learning vs trend learning need different reliability
  curves) would replace `blendEstimate`'s "trust by sample count"
  shape across `getLearnedNapDuration`, `getLearnedNightDuration`,
  `getWakeWindow`, and the trend target.

- **Fast / slow estimates everywhere.** Pair each learned quantity
  (WW, nap dur, night dur, nap count, habitual wake/bedtime) with
  a fast (2–3-sample half-life) and a slow (10–21-day) estimate.
  Use fast for same-week adaptation, slow for stability,
  `fast - slow` as change detection. Triggers a "first nap shifting"
  or "nap transition" state when divergence exceeds a threshold.

- **Intentional schedule-shift detection.** The current re-anchor
  fires on `wakeOffset >= cycleMin` alone, which is noisy (one
  bad-sleep night looks the same as deliberate later-bedtime). A
  multi-signal detector (monotonic wake drift over N days +
  late-bedtime actions + cap-following streak + parent override
  history) would let "intentional shift" mode briefly weight
  today's anchors over historical ones without false positives.

- **Onset latency feeds wake-window learning.** `assessLatency`
  already classifies too-early / too-late put-downs. Repeated
  `20+` latency at the first nap should lengthen position 0's WW
  faster than passive start-time averaging. Today the signal
  reaches guidance UI but not the learner.

- **Prediction residual tracking.** Store or recompute
  (predicted nap start − actual start), (predicted nap end −
  actual self-wake), (predicted bedtime − actual night start),
  (predicted night end − actual wake). Signed residuals are
  adaptation gold; 3 consecutive +35-min residuals on first nap
  should adapt on day 3, not after a 7-day average.

- **Imported data vs in-app reliability.** `parseNapperCsv`
  imports mood/comment fields, but imported categories and inferred
  nights should carry a lower source-quality weight until validated
  by fresh in-app logs. Today imported and fresh samples count
  equally.

- **One-tap feedback after recommendations.** "too early / about
  right / too late" buttons after a nap finishes are a faster
  signal than waiting for passive sleep logs. Trains residual
  bias directly. Codex notes this is one of the cheaper big-impact
  product additions if we want to keep the user-feedback loop
  tight.

## Cycle estimator v2 — replace the subharmonic finder

Source: 2026-05-20 Codex investigation (`local/codex-cycle-estimator.md`)
prompted by the user asking why `estimateSleepCycleFromData` returned
37 min for an 11mo. Reading the actual literature (Lopp et al. 2017:
NREM/REM cycles ~57.5 ± 2.4 min at 9 months; Grigg-Damberger: 50-60
min for healthy term infants) plus all 202 prod naps showed the
current function is a subharmonic finder, not a cycle estimator:

- Search range 35-60 admits biologically implausible cycles. With nap
  durations clustered at common multiples (e.g. 110 min on Halldis),
  c=55, c=37, c=27.5 all fit at zero distance. No prior over plausible
  c, no penalty for higher multiples, no margin requirement → smaller
  divisors win when naps are common multiples.
- Codex checked all 35 self-wake naps in prod since 2026-01-06: the
  scorer picks c=40, not 55. Restricting to 50-65 picks 52-53. The
  full-history "self-only" instinct is directionally right but the
  math itself is broken; equal-weighted all-history is also wrong
  because January data is a different age/regime/logging context.
- The current function silently mislabels its output as "lært syklus"
  in the UI (`SleepInsightsCard.svelte:74`, `+page.svelte:618`)
  without surfacing confidence. NapBudget cap-cycle math
  (`nap-budget.ts:153`) and rescue/short-nap thresholds
  (`state.ts:840`, `state.ts:966`) consume it the same way.

Concrete v2 (from Codex's memo):

```ts
export interface SleepCycleEstimate {
  minutes: number;
  source: "age-default" | "learned";
  confidence: "low" | "medium" | "high";
  sampleCount: number;
  scoreMargin: number;
  candidateRange: [number, number];
}
export function estimateSleepCycleDetails(ctx: BabyContext): SleepCycleEstimate;
```

Pieces:
1. `getSleepCyclePrior(ageMonths)` — research-backed Gaussian prior.
   6-12mo: mean 55, range 50-65. 12-24mo: mean 60, range 55-70.
   newborn/emerging: return age-default unless physiological data.
2. `collectCycleNapSamples(ctx)` separate from `censorCutShortNaps` —
   strict `woke_by === "self"` only, long-horizon (180d or all-history
   while DB is tiny), age/regime-weighted (downweight different
   dominant-nap-count days), exclude off-days. **Do not include
   `woken` and do not import the cap-respect carve-out** — those
   carve-outs are right for learned nap duration, poison for cycle
   estimation.
3. Add a new `ctx.cycleSleeps` long-horizon window in
   `src/lib/server/state.ts` — separate from the 7d recent and 30d
   trend fetches. Start at 180 days or all-since-birth.
4. Prior-weighted scoring inside the candidate range. Score = Gaussian
   prior penalty × multi-cycle fit. Require margin to beat
   age-default before returning `source: "learned"`.
5. UI: don't say "lært" if source is age-default or confidence is low.
6. Late-wake re-anchor: continue using age-default OR a dedicated
   `estimatePhaseShiftCycleMin(ctx)` that only accepts medium/high
   confidence inside the age-plausible range.

Also fix the censoring loophole flagged in the same investigation:
`censorCutShortNaps` falls back to returning all naps unchanged when
`stableMedianMin` < 3 samples (`schedule.ts:1124`). Acceptable for
duration learning; not acceptable for cycle estimation. The v2 sample
collector should handle the no-self-wake case explicitly with low
confidence + age-default fallback.

Tests to add:
- Halldis-shape fixture (1-nap, 6 woken + 1 self): cycle estimate
  should return age-default with low confidence + a margin field
  showing learned candidates within 0.005 of each other.
- Same baby with all 5+ self-wakes at ~110 min: should return ~55
  with medium/high confidence.
- 7mo fixture with all self-wakes at ~50 min: should return ~50 with
  high confidence (the prior allows it).
- Synthetic "all naps at 111 min" cluster: scorer must not pick c=37.

Priority: after the trend intervention-target split. The cycle
estimator's brittleness is real but its current impact is bounded
(UI label + napBudget cap-cycle math + rescue thresholds), whereas
the trend ratchet is the higher-visibility live user complaint.

**Research citations to draw from when implementing v2** (Codex
literature read 2026-05-20 — kept here so they survive memo cleanup):

- Lopp et al. 2017, *Developmental Changes in Ultradian Sleep Cycles
  across Early Childhood* — Jenni et al. cited at mean cycle duration
  **57.5 ± 2.4 min at 9 months**. Longitudinal nocturnal EEG +
  survival analysis of cycle/episode duration distributions.
  <https://journals.sagepub.com/doi/10.1177/0748730416685451>
- Grigg-Damberger 2016, *The Visual Scoring of Sleep in Infants 0 to
  2 Months of Age* — healthy term infant cycles 50–60 min, broad
  newborn range. <https://pmc.ncbi.nlm.nih.gov/articles/PMC4773630/>
- Akacem et al. 2015 — napping toddlers have later melatonin onset
  and shorter night sleep; nap duration is NOT a clean multiple of
  intrinsic cycle length, parental/environmental factors dominate.
  <https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0125181>
- Nakagawa et al. 2016 — at 1.5y, nap duration and nap timing
  correlate with shorter/later night sleep.
  <https://www.nature.com/articles/srep27246>
- SHINE 2020 — parent-reported day sleep overestimated by 29-31 min
  vs actigraphy; relevant when seeding priors from parent logs.
  <https://academic.oup.com/sleep/article/44/4/zsaa217/5937496>

Implication for v2: parent-logged nap durations are NOT a direct
signal of NREM/REM cycle length. The age-prior (mean 55 ±5 for
6-12mo) carries more weight than data fits in this estimator.

## Open items from the 2026-05-20 Codex critique (arc / trend / wake-rec)

Codex (`local/codex-arc-trend-critique.md`) flagged a batch of bugs and
smells in the trend / nap-budget / arc subsystem after the user reported
the trend target walking downward, a rigid 10:53 wake suggestion, no
morning surfacing of the trend cap, and clamped arc endpoints. This
pass shipped four small fixes (positional first-WW, sparse-7d stdev
mean, rounded wake-by window, napBudget-driven arc marker). What's
deliberately deferred:

- **Trend ratchet — separate observed average from intervention target.**
  `computeBlendedTrend` (`src/lib/engine/trend.ts:37`) feeds today's
  capped totals back into tomorrow's mean. `computeNapBudget`
  (`src/lib/engine/nap-budget.ts:152-185`) then writes `trend - 5m`
  back into history every time the parent obeys. Net: a slow downward
  walk (Halldis: 13.0 → 12.9 → 12.8 over a few days). Fix needs a
  held baseline / floor that only moves on independent self-wake
  evidence. Add a closed-loop simulation test (14-30 days of "parent
  follows advice") that asserts the target does NOT ratchet down.

- **Dynamic arc time domain.** `getDayArcConfig` / `getNightArcConfig`
  in `src/lib/arc-utils.ts:8-19` return fixed 12-hour windows.
  `timeToArcFraction` clamps overruns. Composed arc therefore clamps
  the active bubble end + wake marker into the endpoint when sleep
  outlives the window — the night-mode screenshot the user sent where
  the wake target disappears off the right. Need: derive arc start/end
  from actual wake/bedtime ± padding ± min span; rescale segments into
  that domain instead of clamping meaning into decoration. The
  `arc-utils.unit.ts:14-33` tests currently pin the fixed-domain
  behavior — must be updated alongside.

- **Morning forward-projected day-budget object.** `napBudget` only
  emits during an active last-of-day nap (`src/lib/engine/state.ts:546`,
  banner gate `src/routes/+page.svelte:569`). Parents want the
  "if today runs like a typical day, cap last nap around X" advice in
  the morning plan, before the nap starts. Build a separate
  `dayBudgetProjection` field that runs the day forward from now and
  surfaces the same cap target as a soft window.

- **Active nap-budget ignores pauses.** `computeNapBudget` only takes
  `{ start_time }` and computes `elapsed = now - start`
  (`src/lib/engine/nap-budget.ts:113`, `:331`). A 20-min pause is
  counted as sleep, so banked totals and wakeBy run too aggressive.
  Thread `activeSleep.pauseTime` / `calcPauseMs` through.

- **Capped naps shouldn't drift learned-typical down.** The cap-respect
  carve-out in `censorCutShortNaps` keeps app-capped naps in the
  learnable pool (`src/lib/engine/schedule.ts:810`). That fixed the
  stale-baseline problem but lets app-induced caps redefine the
  baby's natural nap duration. Needs the "infer wake reason from
  trend" v2 already on this followups doc (§napBudget v2), tuned so
  the learning loop is more conservative than the suggestion loop.

- **Real arbitration between rescue and napBudget.** Today, if
  `napBudget` exists, `rescueNap` is set to null unconditionally
  (`src/lib/engine/state.ts:377`). That avoids two banners but never
  asks which target is earlier or safer. Compare targets, prefer the
  earlier action time, surface the reason.

- **`scorePlan` target-axis is a no-op.** `selectBestPlan` passes
  `naturalBedtimeMs` as the target for both the natural and
  target-guided candidates (`src/lib/engine/schedule.ts:1641-1785`).
  Target-proximity cost is therefore zero against the already-picked
  bedtime, not the parent's actual target_bedtime. Tests at
  `engine-scenarios.unit.ts:2496-2511` reference a "target-nudged"
  third candidate that doesn't exist. Either implement the third
  candidate or delete the lore.

- **Day arc start-click can't reach the overnight it labels.**
  `arcStartLabel` reads `todayWakeUp.wake_time` from the overnight
  that started before midnight, but `todaySleeps` only contains rows
  whose `start_time >= midnight`
  (`src/lib/server/state.ts:57-75`, handler at `+page.svelte:318`).
  Tapping the day-start endpoint after an overnight either misses or
  opens the wrong dialog.

- **`isLastNapOfDay` derived after UI filtering.** Remaining
  predictions are dropped if stale or within 60 min of bedtime, then
  `isLastNapOfDay = !predictedNaps.length` is computed against the
  filtered set (`src/lib/engine/state.ts:458-547`). A not-actually-
  last nap can become "last" because the next prediction was filtered
  out of display.

- **Dead constant + scattered policy literals.**
  `NAP_BUDGET.CYCLE_NUDGE_WINDOW_MIN` is defined but never read.
  `FIRM_PUSH_LEAD_MIN` is defined but the scheduler hardcodes 5
  (`src/lib/server/notification-scheduler.ts:112`). Many policy
  thresholds (25-min continuation, 30-min rescue delay, 3-h horizon,
  60-min stale, 18-h skip guard, 12-h overnight) live as literals in
  `src/lib/engine/state.ts`. Consolidate into `constants.ts` or kill.

- **Arc time math uses browser local TZ, not baby TZ.**
  `arc-utils.ts:11,21` use `Date.getHours()`. The rest of the engine
  is baby-tz-aware. Travel or a remote browser shifts arc geometry
  while predictions stay in baby tz.

- **Arc fallback ghosts invent 45-min sleep blobs.** Skipped-nap and
  bedtime fallback both render a 45-min placeholder
  (`src/lib/arc-utils.ts:168-201`, `arc-scene.ts:449`). It's a
  visual placeholder that reads as engine output. Pull duration from
  `getLearnedNapDuration` / confidence ranges instead.

The full Codex report (with file:line repros and severity grouping)
lives at `local/codex-arc-trend-critique.md` and is intentionally
*not* committed — Codex pair-review notes belong outside git.

## Refactor: unify wake-recommendations into a `WakeRecommendation` union

Source: 2026-05-13 napBudget commits. Four `Prediction` fields now
carry wake-by recommendations with overlapping shape:

- `rescueNap.recommendedWakeTime` (extra-nap / short-prior-nap cap)
- `continuationWindow.{closesAt, capLatestEnd}` (after a cut-short)
- `postSkipPlan.rescue.{recommendedStart, latestStart, wakeBy}` (after a missed nap)
- `napBudget.{wakeBy, recommendedDurationMin, mode, urgency, context}` (trend cap)

Each has its own notification-scheduler branch, in-app banner in
`+page.svelte`, and tests. ~1000 LOC across the two files; expected
deletion ~80-140 LOC.

Proposed discriminant:
```ts
type WakeRecommendation =
  | { kind: "rescue"; target: string; reason: "extra_nap" | "short_prior_nap" | "both" }
  | { kind: "continuation-cap"; target: string; window: { closesAt: string } }
  | { kind: "post-skip-rescue"; target: string; latestStart: string }
  | { kind: "nap-budget"; target: string; mode: "first-contact" | "established";
      urgency: "advisory" | "firm"; context: NapBudgetContext };
```

Migration steps:
1. Add `Prediction.wakeRecommendations: WakeRecommendation[]` derived from
   the existing four fields. Keep old fields populated for one release.
2. Extract a shared `<WakeRecommendationBanner kind={...} target={...} />`
   component used by all four banners; CSS already separated by kind.
3. Extract a `scheduleWakeNotif()` helper in notification-scheduler.ts
   that takes `{ pref, kind, target, leadMin, dedupe, copy }` and
   replaces the four upsert/cancel blocks.
4. Migrate consumers to read from `wakeRecommendations[]`. Delete the
   four old fields. Test fixtures regenerated.

Risks: regression in any of the four shipped flows (each is real and
load-bearing). Code review by Codex must pin behavior before deletion.
Probably one focused PR per consumer (banner, scheduler, dev playground).

## napBudget v2: dynamic woke-reason inference in censorCutShortNaps

Source: 2026-05-13 nap-cap design discussion. v1 ships a real-time
gate on `continuationWindow` (suppressed when `isDayOnTrend`). But
`getLearnedNapDuration` still feeds through `censorCutShortNaps`,
which drops parent-ended naps below the self-wake median from the
learnable pool. So every cap-respecting nap gets censored, and the
learned-typical stays at the pre-cap value forever — chicken-and-egg:
`shortThreshold = learned - cycle*0.5` keeps the rescue path firing
for *future* on-trend caps too, even after we suppress the current
one.

Concrete v2: extend `censorCutShortNaps(naps, median, ?onTrendByDate)`
to take an optional `Map<localDate, boolean>` derived from the trend
window. When `onTrendByDate.get(s.localDate) === true`, treat the nap
as natural (don't censor), regardless of `woke_by`. This is the
"infer wake reason dynamically" approach the user proposed instead of
adding a new `woken_by_budget` enum value to the DB. No schema
change. Over weeks of cap-respect, learned-typical drifts down
naturally toward the budget-aligned duration; the rescue path stops
firing redundantly.

Caveats to think about before shipping: the trend map must use a
look-back-only window (not today) so we don't censor with retroactive
knowledge of an in-progress day; the threshold for "on trend" should
maybe be tighter than the real-time gate so the learning loop is more
conservative than the suggestion loop.

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

## Arc visual rendering — what landed 2026-05-17

Levels #1 and #2 from the prior proposal shipped:

- `src/lib/arc-scene.ts` — pure `composeArc({...}): ArcScene`. All
  geometry rules (very-short→dot, endpoint-proximity marker dedup,
  active wake-band colour, overrun behaviour, endpoint-halo for
  near-endpoint active sleeps) live here.
- `tests/unit/arc-scene.unit.ts` — object-level assertions on the
  four canonical scenarios plus the orthogonality of skipped/rescue.
- `Arc.svelte` consumes the scene and is mostly markup now. Endpoint
  icons now render *after* bubbles so a near-endpoint bubble cap no
  longer fuses with the endpoint glow (the 2026-05-17 screenshot
  complaint). Wake target became a small dot at the bubble outer
  edge + label, replacing the disconnected perpendicular tick.
- `/dev/arc-scenes` page with 8 canonical scenes on a deterministic
  clock. `tests/arc-scenes.e2e.ts` pins each as its own
  `toHaveScreenshot()` so diffs stay scoped.
- `playwright.config.ts` now uses the full Chromium binary + Oslo
  TZ; the headless-shell variant had a TZ bug where `getHours()`
  read UTC even with `timezoneId: 'Europe/Oslo'`. Documented inline.

Level #3 (ASCII renderer) is still open if anyone wants it.

Open follow-up: the autoMorning fixture (`Date.prototype.getHours =
() => 8`) collides with deterministic time-of-day scenes. The
arc-scenes test opts out via a per-file fixture override. Worth
considering a more surgical fixture (e.g. forceTime(hour, minute))
for tests that need stable clocks without flattening every Date.


## Carryover from archived BUGS-2026-04.md

The April 2026 smoke-test log was archived to
[`archive/BUGS-2026-04.md`](./archive/BUGS-2026-04.md) when followups.md
became the canonical todo. Two "must fix" items remained open at that
time and are worth tracking here:

- **Napper import overlapping/open sleeps (B30).** Importing Napper CSV
  doesn't check for existing babysovelogg data in the same time range,
  so an open native night from the same window can collide with an
  imported open night → multi-hundred-hour ghost sleep. Native data
  should win over imports. Cap open sleeps to 24 h and flag anomalies.
  See archive for the original repro (DB row `id=245`, `slp_import_613`).

- **End-sleep form lacks date picker for cross-midnight sessions (B31).**
  The end-sleep modal uses TimeInput (HH:MM only) and infers the date
  from context. For a sleep started Apr 5 and ended Apr 6, that
  inference can pick the wrong day. Add an optional date override, or
  derive the day more robustly from the previous wake-time anchor.


## Pre-existing E2E visual-snapshot drift (2026-05-20)

`bun run test:e2e` fails 11 tests on stale Chromium screenshots, all
pre-existing as of `bea1be7` (independent of the May 2026 slop-cleanup
batches). The diffs are tiny (0.01–0.02 pixel ratio against the 0.005
threshold), so this is most likely accumulated anti-alias / font-render
drift across Chromium versions rather than a behavioural regression.

Failing tests:
- `tests/arc-scenes.e2e.ts` — 8 of 10 scenes
- `tests/bugs.e2e.ts` B11 (predicted-nap overtime label)
- `tests/diaper-stats.e2e.ts` (no-diaper section)
- `tests/stats.e2e.ts` ("7 dagar" / "30 dagar" headers)

Action: refresh snapshots with `bunx playwright test --update-snapshots`
on a clean run, or tighten the per-test fixture so the visual output
stops drifting per Chromium minor.
