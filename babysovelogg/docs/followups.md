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
> rest (grand engine/arc/wake-rec refactors, speculative adaptation
> ideas, already-shipped narrative, low-value edges) was agreed
> not-worth-doing and removed.

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

- **NapBudget established caps land mid-cycle.** `computeNapBudget` uses
  `napBudgetMin − EARLY_WAKE_LEAD_MIN` in established mode → mid-cycle wake, a
  parent reported the baby cried. Candidate: round the established cap DOWN to
  the nearest sleep-cycle boundary. Validate with a prod-db backtest
  (see [[reference_prod_db]]) before shipping — don't change the cap blind.

- **Cold-start suggestion gating is zero-data only.** The home hides
  skipped-nap / rescue / nap-budget / continuation nudges only while a baby
  has *no* history (`isColdStart` in `routes/+page.svelte`). Broader ask: gate
  on calibration trust / a reliability threshold, ideally in the engine so
  arc/Timer/banners agree by construction.

- **Napper import overlapping/open sleeps (B30).** Importing Napper CSV
  doesn't check existing babysovelogg data in the same range, so an open
  native night can collide with an imported open night → multi-hundred-hour
  ghost sleep. Native data should win; cap open sleeps at 24h and flag
  anomalies. Original repro in `archive/BUGS-2026-04.md` (row id=245,
  `slp_import_613`).

## Quick wins

- **Server-TZ leaks in sibling helpers.** Thread baby/family tz into
  `classifySleepType`/`classifySleepTypeByHour`, `calculateAgeMonths`, and
  `computeStrategySignals` (still use process/client-local calendar fields).
  See [[feedback_server_tz]].
- **Low-confidence firm caps.** Optionally cap low-confidence napBudget
  urgency at `advisory` in `engine/nap-budget.ts`.
- **Day-arc start-click can't reach the overnight it labels.** `arcStartLabel`
  reads `todayWakeUp.wake_time` from the pre-midnight overnight, but
  `todaySleeps` only has `start_time >= midnight` (`server/state.ts:57-75`,
  handler `+page.svelte:318`). Tap misses / opens wrong dialog.
- **`isLastNapOfDay` derived after UI filtering.** `state.ts:458-547` computes
  it against the display-filtered set, so a not-actually-last nap can become
  "last". Compute before filtering.
- **Arc time math uses browser-local TZ.** `arc-utils.ts` `hourOfDay`/configs
  use `Date.getHours()`; travel/remote-browser shifts arc geometry while
  predictions stay baby-tz. Use baby/family tz.
- **"Give up and try later" guidance.** When `awakeMs > nextNap + ~20min` and
  no active sleep, surface a directive "vurder å gi seg og prøv igjen om ~20
  min" banner. Ties into existing overdue logic; consider a per-baby latency
  threshold.
- **`priorOvernightSleep` undercounts fragmented mornings.**
  `server/state.ts:85` (`ORDER BY end_time DESC LIMIT 1`) picks one fragment →
  home "Søvn i dag" undercounts.
- **Stats charts drop wakings.** `stats-view-utils.ts:784,977` map `pauses`
  away, so historical charts ignore night wakings. Extend now that the engine
  pause-handling has landed.
- **Shared pause/segment helper.** Extract one helper for `features.ts` +
  `stats.ts:getLongestNightStretches` (two parallel impls can drift) once
  null-resume/overlap semantics are locked.
- **Cross-midnight end-sleep date (B31).** End-sleep modal uses HH:MM only and
  infers the date; for a sleep started one day and ended the next the
  inference can pick the wrong day. Derive from the previous wake anchor or add
  an optional date override.
- **Refresh E2E visual snapshots.** Known stale-Chromium drift (arc-scenes,
  bugs B11, diaper-stats, stats headers). `bunx playwright test
  --update-snapshots` on a clean run, or tighten the fixtures.

### Test coverage / infra quick wins

- Make `dismissSheet()` strict (`tests/fixtures.ts` swallows failures). Pair
  with the e2e snapshot refresh — both need an e2e run to validate.
- E2E for the create-mode `NightWakingEditSheet` "Legg til nattvaking" button.
- **`StrategyOverride` is unwired through `assembleState`.** Surfaced while
  trying to add coverage: `assembleState` calls `determineStrategy(...)` with
  no `override` arg (`engine/state.ts:831`) and `server/state.ts` supplies
  none, so the override only takes effect at the `selectStrategy`/
  `determineStrategy` level, not through the assembly path the app uses. Either
  thread the override through `DayData` → `assembleState`, or confirm it's
  intentionally helper-only and drop the notion of an assembly-level override.

## Parked (keep — has a concrete future trigger)

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
