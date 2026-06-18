# Followups

Tracked work that's ready to act on but not yet shipped. **This is the
durable todo list for this repo** — every agent should add to it when
something surfaces, and remove entries as units land. Don't reinvent
(no `TODO.md`, no `BACKLOG.md`, etc.).

Process rules — Codex pair-review, lateral-thinking checklist,
multi-day testing, the unit-of-work flow — live in
[`workflow.md`](./workflow.md). Don't put process in this file; this
is for tracked product/engine/test work.

> 2026-06-17: backlog drained against a full Codex triage. Everything
> below is either a real quick win or a scoped substantial unit; the
> rest (speculative adaptation ideas, already-shipped narrative,
> low-value edges) was agreed not-worth-doing and removed.
>
> 2026-06-18: Odin pulled the arc refactors + engine architecture units
> back out of the drain — they're the path to a better arc and a twin
> double-line arc, so they're real intended work, not "not-worth-doing".
> Restored verbatim from `f184656^` (the pre-drain followups).
>
> 2026-06-18 (2nd pass): re-audited the WHOLE pre-drain file. Verdict:
> most removals were genuinely shipped (B30/B31, isLastNapOfDay, low-conf
> firm caps, the overdue nudge, wall-clock docs, test-infra helpers) or
> deliberately dropped — the drain was mostly honest. But a handful of
> real, unshipped, uncovered items got swept too; restored below under
> "Engine correctness + smaller units" and "Adaptation layer — long-term
> ideas". The genuinely-shipped narrative stays out.

## Substantial units (worth real work, each its own PR)

- **Emerging/schedule learning ignores fragmented nights.** Coalescing
  (`coalesceNightFragments`) is applied at the newborn/emerging engine
  *entries* for display metrics, but `schedule.ts` still treats each raw
  `night` row as an independent bedtime / night-duration / wake-window
  sample (`schedule.ts` ~977/1815/1860). A baby logged as several short
  `night` rows + awake gaps pollutes learning. Coalesce the learning
  inputs too. Pairs with the newborn-framing unit below.

- **Mid-day re-plans lose positional identity.** Both assemble branches
  re-plan via `selectBestPlan(..., {...ctx, customNapCount: remaining.length})`
  (state.ts:1046-1049, 1176-1181). The re-plan pulls positional WW/duration
  for the *wrong regime* (`getPositionalDataForNapCount(ctx, 1)` for a 2-nap
  baby's afternoon) and discards the real nap-2 habitual anchor. Plans should
  carry absolute day positions and be *consumed*, not re-generated with a
  shrunken count.

- **Newborn: drop the hard night/morning/day-boundary framing.** Newborn
  parents can't model an evening re-sleep; the wall-clock day/night split
  doesn't apply to polyphasic newborn sleep. Direction: in the
  newborn/emerging strategy model the evening as naps + wakings while still
  deriving night totals / longest-stretch from data, not a `getHours()` gate
  (see the wall-clock anchors in `agent-guide.md`). Scope after the
  fragment-learning unit — the two are coupled. Design pass with Codex first.

- **NapBudget v2: dynamic woke-reason inference in `censorCutShortNaps`.**
  `getLearnedNapDuration` feeds through `censorCutShortNaps`, which drops
  parent-ended naps below the self-wake median — so every cap-respecting nap
  is censored and learned-typical never drifts toward the budget. Extend
  `censorCutShortNaps(naps, median, ?onTrendByDate)` with a look-back-only
  `Map<localDate, boolean>`; when on-trend, treat the nap as natural
  regardless of `woke_by`. No schema change. Use a tighter "on trend"
  threshold than the real-time gate so learning is more conservative than
  suggestion.

- **`shortThreshold` does three jobs — split it.** `computeShortNapThreshold(L,C)
  = L − 0.5*C` drives cut-short/continuation, quota sufficiency, AND
  recovery-plan triggering at `countSufficientNaps`, `mostRecentCutShort`,
  `detectRescueNap`. Split into a `napAdequacy(s, ctx)` helper returning
  `{ cutShort, fulfilledQuota, recoveryWarranted }` (quota looser + age-aware).
  Land when the next nap-budget / cycle work touches this code.

- **Cold-start suggestion gating is zero-data only.** The home hides
  skipped-nap / rescue / nap-budget / continuation nudges only while a baby
  has *no* history (`isColdStart` in `routes/+page.svelte`). Broader ask: gate
  on calibration trust / a reliability threshold, ideally in the engine so
  arc/Timer/banners agree by construction.

- **Fragmented-night display/totals ignore wakings (one unit).** Three coupled
  gaps, all rooted in stats/server surfaces not netting `night_waking`:
  (a) `getSleepDayTotals`/`server/state.ts` only count the single overnight
  fragment that straddles midnight, so a wake-up right at midnight (no
  straddling fragment) drops the pre-midnight stretch from "Søvn i dag";
  (b) `stats-view-utils.ts` (`mapped` at ~923, and ~784/977) strip `pauses`
  and there's no night-waking fetch in `fetchFullHistory`, so historical charts
  ignore wakings; (c) `features.ts` and `stats.ts:getLongestNightStretches`
  keep two parallel pause/segment impls that can drift. Do together: a
  night-waking read for stats + one shared pause/segment helper + fragment-aware
  overnight totals. Pairs with the emerging/schedule learning unit above.

## Arc refactors (toward a better arc + a twin double-line arc)

Restored 2026-06-18 from the 2026-05-20 Codex arc/trend/wake-rec critique
(full report: `local/codex-arc-trend-critique.md`, not committed). `composeArc`
in `arc-scene.ts` is already a pure function — good foundation. The blocker
for overlaying two babies on one arc is the fixed time domain (item 1); do
that first, then the twin double-line unit becomes tractable.

- **⭐ Dynamic arc time domain (foundation for the twin arc).**
  `getDayArcConfig` / `getNightArcConfig` in `src/lib/arc-utils.ts:8-19`
  return fixed 12-hour windows. `timeToArcFraction` clamps overruns. The
  composed arc therefore clamps the active bubble end + wake marker into the
  endpoint when sleep outlives the window — the night-mode screenshot where
  the wake target disappears off the right. Need: derive arc start/end from
  actual wake/bedtime ± padding ± min span; rescale segments into that domain
  instead of clamping meaning into decoration. The `arc-utils.unit.ts:14-33`
  tests currently pin the fixed-domain behavior — must be updated alongside.

- **Arc time math uses browser local TZ, not baby TZ.** `arc-utils.ts:11,21`
  use `Date.getHours()`. The rest of the engine is baby-tz-aware. Travel or a
  remote browser shifts arc geometry while predictions stay in baby tz.

- **Arc fallback ghosts invent 45-min sleep blobs.** Skipped-nap and bedtime
  fallback both render a 45-min placeholder (`src/lib/arc-utils.ts:168-201`,
  `arc-scene.ts:449`). It's a visual placeholder that reads as engine output.
  Pull duration from `getLearnedNapDuration` / confidence ranges instead.

- **Day-arc start-click can't reach the overnight it labels.** `arcStartLabel`
  reads `todayWakeUp.wake_time` from the overnight that started before midnight,
  but `todaySleeps` only contains rows whose `start_time >= midnight`
  (`src/lib/server/state.ts:57-75`, handler at `+page.svelte:318`). Tapping the
  day-start endpoint after an overnight either misses or opens the wrong dialog.
  (Note: 2b1f402 "day-start tap edits the prior overnight" may have addressed
  this — verify before re-opening.)

- **NEW (2026-06-18): twin double-line arc on the home Arc.** Goal: render two
  babies as two lines/lanes on the *live* home Arc, not just the `/stats` charts
  (twin overlay already shipped there — P3-1/S2-2b/S2-3). This was deliberately
  de-scoped in `multi-child-support.md:268-277` ("two lanes on Heim … matters
  more than two pretty arcs"), so it's a new intent, not a regression. Depends
  on the Dynamic arc time domain item above: two babies need a SHARED derived
  domain (union of both wake/bedtime spans) before their segments can be
  overlaid coherently. Likely shape: extend `ArcScene`/`composeArc` to carry
  N child series with per-child colour (reuse `--moon` / `--peach-dark` from the
  stats overlay) + stacked or translucent lanes; gate on `family.isTwinMode`.
  Design pass with Codex first; confirm whether double-line beats the existing
  two-lane Heim layout before building.

## Engine architecture refactors (big simplifications, each its own PR)

Restored 2026-06-18 from the 2026-06-12 engine deep review (full read of
`src/lib/engine/` + Codex pair-review). These are the high-leverage
simplifications; each needs its own design pass. The shared-evidence one kills
the misalignment bug class behind several of the substantial units above.

- **One shared evidence layer.** Six modules independently re-derive
  day-bucketing + gap/duration stats with diverging filters: schedule.ts
  (complete-day + censor + regime filter), confidence.ts (none of those),
  calibration.ts (own thresholds that drift from `getLearnedNapCount`),
  emerging.ts consistency fns, features.ts, weighted.ts. Build one
  `DayEvidence`/learned-profile extractor (positional WW {mean, sd, n},
  positional durations, habitual anchors, nap-count posterior, night duration,
  censored sets) computed once per ctx; confidence/calibration/
  emerging-confidence become *reads*. Kills the whole misalignment bug class;
  est. −700–1000 lines.

- **One planning core.** Forward planner, backward planner, scorer,
  stale-replan, comeback compression, fallback-nextNap, skip detection, rescue,
  continuation, napBudget arbitration are variants of "given today's facts,
  choose the next valid plan", spread across schedule.ts + state.ts
  post-processing. Target: `PlanRequest → PlanResult` core; assemble* becomes
  formatting. Includes folding the four wake-recommendation surfaces
  (rescueNap/continuation/napBudget/postSkipPlan) into the already-planned
  `WakeRecommendation` union.

- **Kill or finish the plan-scoring layer.** `scorePlan`'s `W_TARGET` term is
  provably dead in prod: both candidates always carry the same bedtime that is
  also passed as target (schedule.ts:2354,2371), so the scorer arbitrates only
  on WW/duration shape between forward and backward walks of the *same* bedtime.
  Also, the backward walk + scorer read *unfiltered* positional data while the
  forward walk reads regime-filtered data — inconsistent evidence during
  transitions (Codex #5). Either delete backward+scorer (keep a small
  hard-constraint feasibility check for `Prediction.feasible`) or make the
  scorer real (generate genuinely different candidates and score them).
  `plan-scoring.unit.ts` pins the dead divergent-target behavior — it exercises
  a call shape prod never makes.

- **De-duplicate the emerging path.** `predictEmerging` computes
  predictedNaps/nextNap/bedtime/napConfidence/bedtimeConfidence that
  `assembleEmergingPrediction` discards (it re-plans via `selectBestPlan`); only
  sleepWindow/pressure/rolling/fallback-nextNap are used. Reduce emerging.ts to
  context computation; route both strategies through the one planner with
  different visibility policy.

- **Backtest fidelity.** `backtest.ts` replays `predictDayNaps` +
  `recommendBedtime`, not the production assembly path (selectBestPlan +
  derivePostPlanFields + trend state) — MAE numbers silently diverge from
  shipped behavior. A replay harness over `assembleState` (morning, post-nap,
  active-nap, bedtime evaluation points) would also cover stateful trend-target
  work.

- **Unify wake-recommendations into a `WakeRecommendation` union (the wake-rec
  refactor).** This is the worked-out version of the "fold the four
  wake-recommendation surfaces" line in *One planning core* above. Four
  `Prediction` fields carry wake-by recommendations with overlapping shape:
  `rescueNap.recommendedWakeTime` (extra-nap / short-prior-nap cap);
  `continuationWindow.{closesAt, capLatestEnd}` (after a cut-short);
  `postSkipPlan.rescue.{recommendedStart, latestStart, wakeBy}` (after a missed
  nap); `napBudget.{wakeBy, recommendedDurationMin, mode, urgency, context}`
  (trend cap). Each has its own notification-scheduler branch, in-app banner in
  `+page.svelte`, and tests (~1000 LOC across the two files; expected deletion
  ~80–140 LOC). Proposed discriminant `type WakeRecommendation = {kind:"rescue"
  …} | {kind:"continuation-cap" …} | {kind:"post-skip-rescue" …} |
  {kind:"nap-budget" …}`. Migration: (1) add
  `Prediction.wakeRecommendations: WakeRecommendation[]` derived from the four
  fields, keep old fields one release; (2) extract a shared
  `<WakeRecommendationBanner>`; (3) extract a `scheduleWakeNotif()` helper
  replacing the four upsert/cancel blocks; (4) migrate consumers, delete old
  fields, regenerate fixtures. Risk: each of the four flows is real + load-
  bearing — Codex must pin behavior before deletion; one focused PR per consumer.

## Engine correctness + smaller units (restored 2026-06-18 from the drain)

Real, unshipped, not-covered-elsewhere items the drain swept along with the
shipped narrative. Each is small-to-medium and stands alone.

- **Morning forward-projected day-budget (`dayBudgetProjection`).** `napBudget`
  only emits during an *active* last-of-day nap (`state.ts:546`, banner gate
  `+page.svelte:569`). Parents want the "if today runs like a typical day, cap
  the last nap around X" advice in the *morning* plan, before the nap starts.
  Build a separate `dayBudgetProjection` field that runs the day forward from
  now and surfaces the same cap target as a soft window. (Product feature, not
  just a cleanup.)

- **Trend classification uses gross-duration on pause nights.** `classifyTrendDay`
  (`trend.ts:259-260,285`) uses a local `durationOf` (`:314-317`) that ignores
  `s.pauses`, while `computeBlendedTrend` is already pause-aware via
  `durationMinutes`. A night with 60 min of wakings counts at full duration for
  classification, so `nearTarget` can flip `policy-affected` ↔ `natural` on
  waking time rather than actual sleep. Fix: net pauses in `durationOf` (or call
  the shared `durationMinutes`). Pin the new totals deliberately (snapshot churn
  in trend-target diagnostics).

- **Policy classifier uses observed as the near-target reference (circular
  risk).** Held intervention target and observed diverge once cap-following
  begins, but `classifyTrendDay` still uses observed for "near target". Today the
  target-5+jitter lines up; if the reference ever switches to the held target
  without explicit cap-event attribution the classification goes circular. Real
  fix: log a `nap_budget_event` row when the cap fires and the parent acts, then
  classify policy-affected from explicit attribution.

- **Stats full-history fetch silently caps at 1000 rows/child.**
  `loadFullHistory()` requests `limit=10000` but the API clamps to 1000
  rows/child, so a long-lived (or backfilled/imported) baby silently loses its
  oldest rows from every /stats chart. Pre-existing; more visible with two
  children. Fix: paginate, or raise the API cap for the stats read.

- **Habitual bedtime/wake stats use linear minute-of-day + no engine DST suite.**
  Midnight wrap inflates variance (a 23:50/00:10 pair reads ~1360 min apart).
  Switch the *wrapping clock-time samples only* (`collectBedtimeMinuteSamples` /
  `collectNightWakeMinuteSamples`) to circular clock stats — NOT the shared
  `weightedSD`/`weightedMedian` (also used for spans/WWs that must stay linear).
  Narrow exposure (`recommendBedtime` clamps 17:00–23:00; only actually-logged
  00:xx onsets bite), but worth it for correctness + the missing **engine-level
  DST suite**: `dst.unit.ts` covers helpers, but the full `assembleState` path
  through an Oslo spring/fall transition is untested. Do the two together.

- **`NAP_BUDGET.MAX_STDEV_FRACTION` (0.12) needs prod-data validation.** Normal
  day-to-day totals often exceed 12% CV, which silently nulls the trend and
  disables napBudget + the cap-respect carve-outs. Validate the threshold
  against prod data ([[reference_prod_db]]) and retune if it's suppressing more
  than intended.

- **Scattered policy literals → `constants.ts`.** Many thresholds (25-min
  continuation, 30-min rescue delay, 3-h horizon, 60-min stale, 18-h skip guard,
  12-h overnight) live as literals in `state.ts`. Consolidate. (The two dead
  constants are already resolved.)

- **napBudget v2: manual sick / travel / off-day marker.** v1 only suppresses
  napBudget when recent variance is high — which misses the *first* sick day,
  travel/DST days judged on stale local-trend, and growth spurts. Add a per-day
  off-day toggle (sick / travel / spurt / other) that (a) suppresses the
  napBudget advisory for the day and (b) optionally excludes the day from trend
  stats. Schema: `day_marker(baby_id, date, kind, note)` or a column on
  `day_start`; the notification scheduler must respect the same suppression.
  (A generic `off_day` flag exists and flows through `db-to-days`; this is the
  typed, napBudget-aware version.)

- **Multi-baby log: off-day toggle + "+ Legg til søvn" hit the primary baby in
  "Alle" view.** When the log filter is "Alle", `history/+page.svelte` falls back
  to the primary baby for the day-header off-day toggle and the manual add-sleep
  modal (per-child only when a single child is selected). Low impact (per-child
  is the common path); either disable the toggle in "Alle" or prompt which child.

- **Handoff timeline drops pre-midnight non-overnight blocks.** `handoff.ts`
  builds its 6h window from client `BabyState` (priorOvernightSleep + todaySleeps
  + activeSleep). A sleep that both started AND ended before midnight (a
  21:00–22:00 nap) is in none of those once the date rolls, so a small-hours
  (03:00) handoff omits it. Low priority (handoffs are mostly daytime). This is
  the "KNOWN EDGE → followups" that `multi-child-support.md` P3-4 points at — keep
  it tracked. Fix needs a dedicated last-6h fetch or threading recent
  pre-midnight sleeps into `BabyState`.

## Adaptation layer — long-term ideas (parked, not yet planned)

Restored 2026-06-18. These are the "speculative adaptation ideas" the drain
removed. They're big-picture and none are urgent — but they're real product
direction (Codex flagged the feedback loop one as cheap + high-impact), so keep
them visible for when we next touch the relevant code rather than re-deriving.

- **One-tap feedback after recommendations.** "too early / about right / too
  late" buttons after a nap finishes — a faster, directer signal than passive
  sleep logs; trains residual bias. Codex: one of the cheaper big-impact product
  additions if we want to keep the user-feedback loop tight.
- **Prediction residual tracking.** Store/recompute signed residuals (predicted
  vs actual nap start / nap end / bedtime / night end). 3 consecutive +35-min
  first-nap residuals should adapt on day 3, not after a 7-day average.
- **Sample reliability mass instead of sample count.** A self-woke clean nap, a
  parent-woken cap, an imported Napper night, and a fragmented sick-day night are
  different-quality observations. A per-feature `sampleReliability(s, feature)`
  weight would replace `blendEstimate`'s "trust by sample count" across the
  duration/WW/trend learners.
- **Fast / slow estimates everywhere.** Pair each learned quantity with a fast
  (2–3-sample half-life) and slow (10–21-day) estimate; `fast − slow` is change
  detection → triggers a "nap transition" / "first nap shifting" state.
- **Intentional schedule-shift detection.** Replace the noisy re-anchor
  (`wakeOffset >= cycleMin` alone) with a multi-signal detector (monotonic wake
  drift over N days + late-bedtime actions + cap-following streak + override
  history) so deliberate shifts briefly weight today's anchors over history
  without false positives.
- **Onset latency feeds wake-window learning.** `assessLatency` already
  classifies too-early/too-late put-downs; repeated 20+ latency at the first nap
  should lengthen position 0's WW faster than passive averaging. Today the signal
  reaches the UI but not the learner.
- **Imported vs in-app reliability.** Imported categories + inferred nights
  should carry a lower source-quality weight until validated by fresh in-app
  logs. Today imported and fresh samples count equally.

## Parked (keep — has a concrete future trigger)

- **NapBudget established caps land mid-cycle — DON'T tune blind.**
  `computeNapBudget` uses `napBudgetMin − EARLY_WAKE_LEAD_MIN` in established
  mode → mid-cycle wake; a parent reported the baby cried. Candidate: round the
  established cap DOWN to the nearest sleep-cycle boundary. The repo discipline
  requires validating cap-math changes against a **prod-db backtest**
  ([[reference_prod_db]]) before shipping — can't be done from the committed
  fixtures alone, so this waits for a prod-db pass.

- **`getLearnedBedtimeWakeWindow` robustness — DO NOT re-ship blind.** The
  obvious fix (day-aware samples + robust prior-blended estimate +
  age-based final-WW ceiling) was attempted 2026-06-12 and **REVERTED**: it
  regressed backtest bed MAE on every clean fixture (9mo 25.2→37.2, 6mo
  28.7→36.8, etc.) because clean fixtures have no unlogged-last-nap gaps, so
  the blend/ceiling only add downward bias. A real fix needs (a) a fixture
  containing the pathological case (unlogged-nap gap, Umi-shaped) and (b)
  backtest-gated tuning that does NOT regress clean fixtures (gentler/no blend,
  looser ceiling, gated to suppress only clear garbage).

- **3+ children.** Family model hard-caps at 2 (`canAddChild`, twin-vs-sibling
  mode, "begge" bulk actions, overlap roll-ups, `bothAsleep`, `firstWake`).
  Lifting it means generalising pairwise twin/bulk/overlap logic — a real unit.
  Do only if the family actually needs a third tracked child.
