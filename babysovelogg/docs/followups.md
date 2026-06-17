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
