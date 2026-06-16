# Followups

Tracked work that's ready to act on but not yet shipped. **This is the
durable todo list for this repo** — every agent should add to it when
something surfaces, and remove entries as units land. Don't reinvent
(no `TODO.md`, no `BACKLOG.md`, etc.).

Process rules — Codex pair-review, lateral-thinking checklist,
multi-day testing, the unit-of-work flow — live in
[`workflow.md`](./workflow.md). Don't put process in this file; this
is for tracked product/engine/test work.

## Stats charts — Step-1 QA leftovers (P3 / S1-QA, 2026-06-14)

Surfaced by the S1-QA adversarial review of the charting refactor. Neither is a
regression (both pre-date the refactor); both are low priority.

- **Wake-window recommended-range band is unreachable.** `computeAllStats` calls
  `buildWakeScatter(wakeGaps)` with no `recommendedRange`
  (`src/lib/stats-view-utils.ts` ~L988), so the band branch the Vakevindu chart
  renders (`+page.svelte` Vakevindu `underlay`) never draws for single-baby. Either
  pass a real age-based range (the engine has wake-window ranges) or drop the dead
  branch. Predates the refactor.
- **No DOM-level chart-render test.** The golden snapshot pins computeAllStats
  *geometry* (data), and stats e2e asserts presence (`.stats-chart rect`) +
  fullscreen open/close — but nothing pins the *rendered SVG* per chart, so a
  future component edit could drift a chart visually without a red test. Consider a
  Playwright DOM/attribute snapshot per chart on a seeded fixture, or accept the
  golden+presence bar. (Visual pixel snapshots are environmentally fragile here —
  see the arc-scenes note.)
- **charts/types.ts is partly speculative.** Only `LegendItem` is consumed; the
  components use their own inline prop types (`TsSeries`, `TimelineBlockRender`).
  Step 2's multi-child data-shaper should either wire the abstract model types or
  they should be trimmed.

## Stats charts — Step-2 QA leftovers (P3 / S2-QA, 2026-06-14)

Surfaced by the S2-QA adversarial Codex review of all of Step 2 (per-child
panels, twin overlay + shared scales, gantt child-lanes, shared-sleep /
parent-downtime, cross-child comparison). The DST midnight-split bug and the
missing full-history error path were fixed in-unit; these three are logged as
follow-ups (consistent-with-existing-convention or pre-existing, none a
multi-child regression).

- **The whole /stats page uses GROSS sleep spans, not net-of-wakings.** Every
  chart (single + multi-child) sums wall-clock span, so a night with 60 min of
  logged wakings reads at full duration. This is *consistent* across the page and
  mirrors the engine's deliberate "gross for SPAN predictions" convention
  (commit `6ef1081` / the engine net-vs-gross followup above), so it's not a
  multi-child bug — but if /stats ever wants to show *sleep amount* it should net
  wakings like the engine's amount-comparisons do. Cross-cutting; bigger than S2.
- **Full-history fetch silently caps per child.** `loadFullHistory()` requests
  `limit=10000` but the API clamps to 1000 rows/child, so a very long-lived baby
  (or a backfilled import) silently loses the oldest rows from the charts. Pre-
  existing (single-baby had the same cap); becomes slightly more visible with two
  children. Fix: paginate, or raise the API cap for the stats read.
- **Zero-overlap shared-sleep is hidden, not shown as 0.** When two children
  never sleep at the same time, the "Felles søvn" / parent-downtime section is
  omitted entirely (matching the other charts' zero-day filtering) rather than
  rendering an explicit "0 / no shared sleep" state. Defensible, but a parent
  might read absence-of-section as a bug. Low priority; revisit if asked.

## Phase-4 overlap: synced-exclusion coverage + e2e (P4-QA leftovers, 2026-06-16)

The P4-QA multi-day simulation (`tests/unit/overlap-simulation.unit.ts`) surfaced
that the whole synced-exclusion feature was DEAD in prod — `toSleepEntry` dropped
the flag (now fixed) — and that the habitual nap-start learner lacked the skip
(also fixed). Remaining, lower-priority:

- **2nd-order synced-gap coverage.** A synced (nudge-accepted) nap moves a START
  but keeps duration, so its END also shifts. Two gaps computed from that end are
  still learned as natural: (1) **bedtime WW** — `getLearnedBedtimeWakeWindow`
  (`schedule.ts` ~L949) uses the last-nap→night gap with no synced check, so a
  synced last nap inflates the learned bedtime wake window; (2) **next-nap WW** —
  the positional/avg WW loops skip a nap when *it* is synced, but a non-synced nap
  *following* a synced one still measures its gap from the synced nap's shifted
  end. Both are second-order (one nap nudged per day, usually the relevant one).
  A one-liner reverted from the P4-QA unit (excluding synced from
  `getLearnedBedtimeWakeWindow`) cascaded into bedtime predictions, so this wants
  a deliberate pass + Codex review, not a blind skip. Do a full audit of every
  nap-start/gap reader (incl. trend.ts, cycle `collectCycleNapSamples` — likely
  fine since cycle is duration-based) and decide each. Duration learning must NOT
  skip synced (a nudged nap is still real sleep of its true length).
- **Live-suggestion e2e.** Still want a Playwright e2e for the `FamilyOverlapCard`
  what-if flow ([Gjer det] logs a synced sleep / [Ikkje no] dismisses). Gated on
  being able to deterministically seed a live overlap suggestion in the browser
  (two twins, awake, overlapping-but-not-aligned predictions, medium+ confidence)
  — the unit sim shows the fixture is fiddly (SD must land ~30-39 for a usable
  ±1σ window that isn't low-confidence-blocked).

## E2E/integration: multi-child `bothAsleep` roll-up is wall-clock-fragile

`tests/integration/multi-child.test.ts` "family roll-up: bothAsleep needs both
children down" posts active sleeps at hard-coded `2026-06-14T09:30/09:40Z` with no
end, then asserts `bothAsleep=true`. Once the real clock is >24h past those starts
(i.e. from 2026-06-15 on) the engine classifies them as stale and hides them, so
`bothAsleep` reads false and the test fails — independent of any code change
(verified failing on clean `main`). Same class as the arc-scenes/B18 fragility.
Fix: thread a pinned `now` into the family roll-up path under test (or use
relative-to-now start times) so it's clock-independent.

## Handoff timeline: pre-midnight non-overnight blocks dropped (P3-4)

The family handoff (`src/lib/handoff.ts`) builds its 6h window from the
client-side `BabyState` (priorOvernightSleep + todaySleeps + activeSleep).
A discrete sleep that both started AND ended before midnight (a 21:00–22:00
nap, say) is in none of those once the date rolls, so a handoff opened in the
small hours (e.g. 03:00) silently omits it. The dominant overnight block still
shows. Low priority (handoffs are mostly daytime/evening). Fix would need a
dedicated last-6h fetch or threading recent pre-midnight sleeps into BabyState.

## Engine deep review — 2026-06-12 (Claude full read + Codex pair-review)

Source: full end-to-end read of `src/lib/engine/` plus an independent
Codex review (session `019ebb96-7ff4-7a03-9400-44b810e4c77d`). Bugs are
verified unless marked suspicion. Work the bugs first; the architecture
units are the high-leverage simplifications and should each get their
own design pass.

### Verified bugs

**Landed 2026-06-12** (4 of 6 — quick units first, Codex pair-reviewed):

- ~~**Confidence positional SDs off by one nap position.**~~ Fixed in
  `confidence.ts:getNapWakeWindowStats` by mirroring schedule.ts's
  `morningWakeMs` — position 0 now anchors to the previous day's last
  night end (wake→nap1) instead of nap1→nap2. ±1 SD coverage on the
  Halldis fixture rose 64% → 76% (closer to the 68% ideal). Regression
  pinned in `confidence.unit.ts` ("positional SD aligns position 0…").
- ~~**Active night emits `nextNap`/`bedtime` in the past.**~~ Fixed in
  `derivePostPlanFields`: during an active night `nextNap = null` (no
  actionable next-step; `expectedNightEnd` is the live signal). The
  non-active-night `napsAllDone` collapse to bedtime is unchanged.
  I-7 invariant in `engine-scenarios.unit.ts` rewritten to pin it.
  Verified: Timer's active-sleep branch returns before reading
  `nextNap`, so the change is display-safe.
- ~~**Server-TZ leaks into `shouldReclassifyAsNight`.**~~ Fixed: it now
  takes an optional `tz` and reads `getHourInTz`; both `projections.ts`
  call sites pass `getFamilyTimezone()`. Strict improvement over the
  unconditional `start.getHours()` and consistent with the established
  replay-determinism contract (`baby.created` seeds `family.timezone`
  before any sleep event; null falls back without persisting).
  Regression pinned in `classification.unit.ts`. STILL OPEN within this
  bug: `classifySleepType`/`classifySleepTypeByHour` default to
  `new Date().getHours()` (client local — OK in practice but not
  baby.timezone), and `calculateAgeMonths` + `computeStrategySignals`
  use process-local calendar fields. Thread baby tz there too
  (see [[feedback_server_tz]]).
- ~~**Habitual wake off by a day for post-midnight bedtimes.**~~ Fixed
  in `getHabitualWakeTimePrediction`: wake date keys off the start's
  local hour (`>= 12` → next local day, else same morning) instead of
  an unconditional `setUTCDate(+1)`. New DST-safe `addLocalDay` helper.
  Regression pinned in `schedule.unit.ts`.

**Still open (1 of 6):**

- ~~**Pause-aware duration math inconsistent across consumers.**~~ Resolved
  2026-06-12, but NOT by "net everywhere" — that premise was wrong. The
  decision is **net for sleep-AMOUNT comparisons, gross for wall-clock SPAN
  predictions**: `trend.ts:classifyTrendDay` and `censorCutShortNaps`' day
  totals now net via a shared `netDurationMin(s)` (exported from stats.ts),
  because both compare against the *net* trend reference. `getLearnedNightDuration`
  and confidence's night variance stay GROSS on purpose — night-end is predicted
  as `bedtime + span` and the baby is in the crib through the wakings, so netting
  would predict wake too early; both now carry a comment saying so. `buildCache`
  is untouched (the net-needing consumers read raw entries with `.pauses`).
  Pinned: a 60-min-waking night nets to 840 not 900, and a 140-min-waking
  parent-woken night flips policy-affected→natural (trend-targets.unit.ts).
- **Mid-day re-plans lose positional identity.** Both assemble branches
  re-plan via `selectBestPlan(..., {...ctx, customNapCount: remaining.length})`
  (state.ts:1046-1049, 1176-1181). The re-plan then (a) pulls positional
  WW/duration data for the *wrong regime* (`getPositionalDataForNapCount(ctx, 1)`
  for a 2-nap baby's afternoon), and (b) discards the real nap-2 habitual
  anchor (position 0's habitual start is the morning nap; the
  `habitualMs > currentWake` guard then drops it). Plans should carry
  absolute day positions and be *consumed*, not re-generated with a
  shrunken count.

### Architecture: big simplification candidates (each its own unit)

- **One shared evidence layer.** Six modules independently re-derive
  day-bucketing + gap/duration stats with diverging filters:
  schedule.ts (complete-day + censor + regime filter), confidence.ts
  (none of those), calibration.ts (own thresholds that drift from
  `getLearnedNapCount`), emerging.ts consistency fns, features.ts,
  weighted.ts. Build one `DayEvidence`/learned-profile extractor
  (positional WW {mean, sd, n}, positional durations, habitual anchors,
  nap-count posterior, night duration, censored sets) computed once per
  ctx; confidence/calibration/emerging-confidence become *reads*. Kills
  the whole misalignment bug class above; est. −700–1000 lines.
- **One planning core.** Forward planner, backward planner, scorer,
  stale-replan, comeback compression, fallback-nextNap, skip detection,
  rescue, continuation, napBudget arbitration are variants of "given
  today's facts, choose the next valid plan", spread across schedule.ts
  + state.ts post-processing. Target: `PlanRequest → PlanResult` core;
  assemble* becomes formatting. Includes folding the four
  wake-recommendation surfaces (rescueNap/continuation/napBudget/
  postSkipPlan) into the already-planned `WakeRecommendation` union.
- **Kill or finish the plan-scoring layer.** `scorePlan`'s `W_TARGET`
  term is provably dead in prod: both candidates always carry the same
  bedtime that is also passed as target (schedule.ts:2354,2371), so the
  scorer arbitrates only on WW/duration shape between forward and
  backward walks of the *same* bedtime. Also, the backward walk +
  scorer read *unfiltered* positional data while the forward walk reads
  regime-filtered data — inconsistent evidence during transitions
  (Codex #5). Either delete backward+scorer (keep a small hard-
  constraint feasibility check for `Prediction.feasible`) or make the
  scorer real (generate genuinely different candidates and score them).
  `plan-scoring.unit.ts` pins the dead divergent-target behavior — it
  exercises a call shape prod never makes.
- **De-duplicate the emerging path.** `predictEmerging` computes
  predictedNaps/nextNap/bedtime/napConfidence/bedtimeConfidence that
  `assembleEmergingPrediction` discards (it re-plans via
  `selectBestPlan`); only sleepWindow/pressure/rolling/fallback-nextNap
  are used. Reduce emerging.ts to context computation; route both
  strategies through the one planner with different visibility policy.
- **Backtest fidelity.** `backtest.ts` replays `predictDayNaps` +
  `recommendBedtime`, not the production assembly path
  (selectBestPlan + derivePostPlanFields + trend state) — MAE numbers
  silently diverge from shipped behavior. A replay harness over
  `assembleState` (morning, post-nap, active-nap, bedtime evaluation
  points) would also cover the stateful TrendTargetState item below.

### Smaller cleanups

- `decomposeFirstNapPrediction` hand-mirrors `predictDayNaps`' first
  iteration (drift risk) — derive via an optional trace hook instead.
- Learned cycle estimator feeds only rescue/napBudget thresholds;
  `predictNapEndTime`/`predictNightEndTime`/re-anchor/scorer still use
  the age prior (re-anchor deliberately, the rest incidentally). One
  confidence-gated cycle provider (Codex #6). Adversarial pair-review
  2026-06-12 sharpened the wiring conditions: payoff is single-digit
  minutes (snap blend is 0.3, scorer W_CYCLE=0.1; worst case ~8 min on
  night end), and v2 can still confidently learn an in-range harmonic
  alias (routine 100-min "self-wakes" → c=50 at k=2 passes the
  outside-prior high-confidence override with alignedStd=0). If wired:
  gate on `source="learned" && confidence="high"` AND within prior 1σ
  AND an alias-diversity check (k=1 samples ≥ max(3 eff. samples, 25%
  eff. weight), or ≥2 k-buckets each ≥25%) — never medium. Keep the
  re-anchor on age-default. Note the daily backtest can't validate this
  wiring: it scores `predictDayNaps` planned ends, which use raw
  learned duration without cycle snap (backtest.ts:253,
  schedule.ts:295) — needs active-nap/active-night replay.
- `getLearnedBedtimeWakeWindow` learns from every nap→night gap with
  only a 60–600 min filter — no complete-day, off-day, regime, or
  censoring treatment, yet it drives `recommendBedtime` directly
  (Codex #8; recency is partly covered by the 7-day `recentSleeps`
  window). Adversarial pair-review 2026-06-12 ranked the holes: (1) the
  600-min cap admits unlogged-last-nap gaps (one 480-min gap + one
  250-min gap → mean 365); (2) n=2 cliff straight to raw mean with no
  `blendEstimate` ramp; (3) no robust estimator — any outlier dominates
  a 2–7 sample window. Morning plans are the exposed case: the
  `allSynthetic` ×0.5 penalty caps habitual-bedtime damping at weight
  ~0.425, so a +120-min bad WW still moves the morning bedtime ~+69 min
  before target/clamp. Minimal fix: day-aware samples (off-days out,
  prior sleep must be that local day's last nap, regime filter,
  age-based final-WW ceiling instead of 600) + robust prior-blended
  estimate (trimmed/winsorized, recency-weighted,
  `blendEstimate(defaultWW, learned, n, 3, 7)`).
  **2026-06-12 attempt REVERTED — the exact prescription above regresses
  backtest bed MAE on every clean fixture** (9mo 25.2→37.2, 11mo 21.1→34,
  6mo 28.7→36.8, day15+ 21.5→27.1). Diagnosis: the clean fixtures contain
  *no* unlogged-last-nap gaps, so the robustness changes add only bias —
  the `blendEstimate` pull toward the age-mid default and the `max×1.6`
  ceiling both bias a well-learned (long) final WW *downward*, predicting
  bedtime too early. The naive raw mean fits these fixtures better. Real
  unit needs: (a) a fixture that actually contains the pathological case
  (unlogged-nap gap, e.g. Umi-shaped) to prove the robustness *helps*,
  and (b) backtest-gated tuning that does NOT regress clean fixtures —
  likely a much gentler blend (or none) + a looser ceiling, gated so it
  only suppresses clear garbage. Do NOT re-ship the prescription blind.
- Habitual bedtime/wake medians + SDs use linear minute-of-day
  (midnight wrap inflates variance — a 23:50/00:10 pair reads ~1360 min
  apart). Switch to circular clock stats; add an engine-level DST suite
  (Codex #12, suspicion-grade for DST impact). (The `buildSleepsForBedtime`
  date-aware cutoff half landed 2026-06-12 — an after-midnight nap end no
  longer slips under the evening cutoff via minute-of-day.)
  **2026-06-12 scope note:** the exposure is narrower than it looks.
  `recommendBedtime` clamps bedtime to 17:00–23:00 and morning wakes don't
  straddle midnight, so the wrap only bites for *actually-logged*
  post-midnight bedtime onsets (00:xx) mixed with evening ones — uncommon
  for this app's babies. Worth doing for correctness + the DST suite, but
  apply circular math ONLY to the wrapping clock-time samples
  (`collectBedtimeMinuteSamples` / `collectNightWakeMinuteSamples`), NOT to
  the shared `weightedSD`/`weightedMedian` (also used for spans/WWs that
  must stay linear). Low priority vs. the regression-bearing items above.
- Tunable to validate against prod data: `NAP_BUDGET.MAX_STDEV_FRACTION`
  (0.12) — normal day-to-day totals often exceed 12% CV, which silently
  nulls the trend and disables napBudget + cap-respect carve-outs.

## Multi-child support (twins + siblings) — see dedicated plan

Source: 2026-06-12 — a family now has twins, plus we want to track
older siblings for fun. The app is single-baby today. Multi-phase
roadmap lives in [`multi-child-support.md`](./multi-child-support.md):
Phase 1 (add a child + family home, delivers mixed-age siblings),
Phase 2 (logging ergonomics + at-a-glance), Phase 3 (combined graphs +
overlap), Phase 4 (opt-in schedule coupling).

**Phase 1 — backend foundation: LANDED (2026-06-12).** `getState` split
into `getBabyState(babyId, now)` + `getFamilyState(now)` (family snapshot
with `babies[]`; newest baby spread as legacy top-level alias so N=1 is
byte-for-byte). `baby.updated` corruption trap closed: event carries
`babyId` (schema + projection + `buildBabyEvent`), falls back to newest
only for replay-compat. Timezone moved to a **single-row `family` table**
(DB == one family; deploy/manage.sh) so the two babies can never diverge;
read via `getFamilyTimezone()`, set via new `family.updated` event,
replay-compat from `baby.created`/`baby.updated{timezone}`,
rebuild-deterministic (non-writing fallback). API GET routes take `?baby=`.

**Phase 1 — client store, add-child UI, family home, notifications: all
LANDED (2026-06-12).** Client store holds `babies[]`/`babiesById`;
optimistic events route by `payload.babyId` (else owning-domain slice, else
primary). Settings adds/edits per child (`?new=1` / `?baby=<id>`); home shows
lanes + "Sove/Vakne begge" at 2+ children, with a per-baby focus view
(`/?baby=<id>`). Notifications: family-wide push delivery (sendPushToFamily;
the DB is one family), baby-scoped dedupe keys + tags, baby-named push titles
when multi, per-baby prefs via `?baby=`, and `/api/events` reconciles every
`state.babies` slice. E2E regression pin landed: "edit the first child after a
second exists" + "log on one lane lands on that child only".

So Phase 1 is functionally complete. Remaining polish / deferred:

From the client+UI Codex review (2026-06-12) — must-fixes already landed
(off-day toggles in TagSheet/WakeUpSheet now use the focused baby; sleep.deleted
clears activeSleep; cached state normalized).

The three lower-priority client-state leftovers **LANDED (2026-06-12)**: the
active-sleep periodic refresh now goes through a new `sync.refresh()` (normalize
+ cache + pending-queue overlay, no more raw `appState.set`); the SSE update
handler got the same overlay (it had the identical bug); the settings form reset
is keyed on baby identity (`formKey`) so an SSE refresh no longer clobbers
unsaved edits; EditSleepModal resolves the entry's own slice by `entry.baby_id`
for undo-eligibility. New e2e pins the settings-clobber case.

Still open from the Codex review of that polish (2026-06-12):
- **No revision/version on `AppState` → last-writer-wins races.** `sync.refresh()`,
  `sendEvents()`, and the SSE handler all `appState.set(...)` unconditionally
  (`sync.svelte.ts`; `app.svelte.ts:set`). A slower/older `/api/state` response can
  land after a newer event-response or SSE and briefly clobber it. Pre-existing,
  but `refresh()` makes it marginally more reachable. Fix: stamp state with a
  monotonic server revision and drop stale applies in `appState.set`.
- **EditSleepModal undo coverage gap.** The fix-3 slice resolution is verified by
  Codex + the unit-tested `isWithinEndUndoWindow`, but there's no e2e for
  "focused non-primary baby + undo-end eligibility" (opening EditSleepModal needs
  an arc-segment tap, fragile). Add when the arc has a stable test handle.

Deferred from the backend unit's Codex review (2026-06-12):
- **`getBabyState` mixes pure snapshot assembly with derived-state writes**
  (nap-budget mode + trend-target persistence). Fine at N≤2; later split
  read from persist (or add a `persistDerived` flag) so a pure family
  snapshot can be computed without side-effects.
- **SSE/state payload duplicates the primary baby** inside `babies[0]` plus
  the top-level alias. Acceptable at N≤2; slim to a summary if SSE size
  ever matters (and once the client reads `babies[]` natively).

## Stale active sleep — shipped, minor edges parked

Source: 2026-06-10 phone-bug report (timer at 466:34:51 — a forgotten
wake left an open sleep counting up ~19 days). Shipped: pure
`classifyActiveSleep` (`src/lib/stale-sleep.ts`, 24h→`stale`,
48h→`abandoned`); `getState` hides an over-a-day open sleep from the
engine and surfaces it as `staleActiveSleep`; dashboard resolve banner
(set real wake via `WakeUpSheet` `closingStale`, or discard); forced
morning re-onboarding at 48h with orphan auto-discard on `day.started`.

Parked edges (not urgent):
- **Offline staleness lag (entry side).** The optimistic offline path
  doesn't re-classify by elapsed time, so a cached open session only
  flips *into* stale on the next server fetch. Deep edge (offline + a
  >24h-open session); reclassify client-side if it ever matters. (The
  *exit* side is handled: optimistic `sleep.deleted` / `sleep.updated`
  with endTime now clear `staleActiveSleep` — Codex 2026-06-10 review.)
- **Double surface in the 24–48h window.** During 05:00–13:00 a `stale`
  (not yet abandoned) session shows both the morning prompt and the
  resolve banner. Coherent but slightly busy — revisit if it reads as
  noise.

## napBudget / Timer screenshot batch — 2026-06-10

Source: phone bug screenshots of the napBudget/trend feature + Timer.
Shipped this pass:
- Timer expected-wake now respects the active cap (napBudget.wakeBy /
  rescueNap) instead of showing the natural nap-end that contradicted the
  banner + arc.
- "Målet ditt er ikkje nåeleg i dag" only shows when a manual
  target_bedtime is set (auto-bedtime users have no parent goal).
- Dropped the internal `sourceLabel` ("held baseline (observed-initial)")
  from the napBudget explainer copy.
- Skipped-nap surface no longer shows a degenerate "(0m før normalt)"
  earlier-bedtime tip and yields to after-bedtime once bedtime has passed.
- **Cap-respect wake now tags `woke_by='woken'`** (`buildEndSleep` +
  SleepButton `wakeCapActive`). This closes the napBudget→continuation
  contradiction ("vekk for trenden" → parent wakes → "Forleng luren"):
  `shouldSuppressContinuation` already suppressed substantial woken naps,
  but nothing had ever set the tag. WakeUpSheet pre-selects it (correctable).
- Hid the "~X min til neste lette fase" Timer hint while a cap is active
  (it contradicted a mid-cycle "vekk no").

Deferred — need more than a unit test:
- **Established/"presis modus" caps mid-cycle.** `computeNapBudget` in
  `nap-budget.ts` uses `napBudgetMin - EARLY_WAKE_LEAD_MIN` in established
  mode, which lands mid-cycle → harder wake (a parent reported the baby
  cried, 2026-06-01). Candidate: round the established cap DOWN to the
  nearest sleep-cycle boundary so it still lands under-budget but in a
  light phase. This shifts how close established days land to the trend
  target, so validate with a prod-db backtest (see [[reference_prod_db]])
  before shipping — don't change the cap math blind.
- **Phantom active sleep (needs repro).** 2026-05-27 19:27: dashboard
  showed an active night sleep started 19:23 the parent says they didn't
  log. A fresh 19:23 start means a `sleep.started` event at 19:23; the
  only client emitter is the Sove button, so the leading hypothesis is an
  accidental tap (parent hedged "from yesterday or something?"). No
  auto-start path exists. Next repro: check `/events` for that baby around
  the timestamp (client_id + event time) to confirm tap vs. sync replay.
  The >24h stale-sleep guard catches the persistent case; a fresh
  accidental tap is covered by the 8s undo toast.

## Pause UX redesign — see dedicated plan

Source: 2026-05-22 design pass with Codex pair-review. Plan lives in
[`pause-redesign-2026-05-22.md`](./pause-redesign-2026-05-22.md).
Stages 1–4 shipped 2026-05-24: `Angre slutt` button + first-class
`night_waking` events with edit sheet, red arc overlays, history
rows, indexed migration of existing pauses, and nap-pause UI ripped
out. Engine now reads `night_waking` for night-sleep duration
netting; `sleep_pauses` stays as a frozen archive for legacy nap
data.

Stage 5 (polish) pending:
- Arc red sub-band dark-mode contrast pass.
- Edits to migrated wakings (`nwk_pse_*` IDs) are lost on `rebuildAll`
  — the migration re-seeds the row from sleep_pauses with original
  values, so any later `night_waking.edited` event whose target
  doesn't yet exist soft-fails. Acceptable edge case (admin-only
  flow), but a cleaner fix would mirror-write to night_waking from
  the legacy `sleep.paused` projection.
- ~~Drop `sleep_pauses` table + legacy `sleep.paused`/`sleep.resumed`/
  `sleep.pause_deleted` projections.~~ Shipped 2026-05-25 (commit
  `2b55d9d`).


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

- ~~**Drift epoch gate is time-based, not data-based.**~~ Shipped
  2026-05-25. Replaced the UTC-date gate with an evidence fingerprint
  (sorted `${date}:${kind}:${totalMin}` over evidence-bearing days +
  observed mean) so backfills on the same date re-fire drift, and
  repeated calls within the same evidence frame don't ratchet
  target/streak even when the upward path would normally mutate
  targetMin in place. New `evidenceFingerprint` column on
  `trend_target_state`; legacy rows migrate idempotently with a
  same-UTC-day safety belt so pre-deploy rows can't double-advance
  on their first new-code fetch. Codex pair-review picked design B
  (full 30-day fingerprint over evidence-bearing days) and approved
  the diff.

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

## Cycle estimator v2 — shipped 2026-05-25

Replaced the subharmonic finder `estimateSleepCycleFromData` with
`estimateSleepCycleDetails(ctx): SleepCycleEstimate` (minutes + source
+ confidence + diagnostics). Codex pair-review iterated three times
(2026-05-24 design, 2026-05-25 final diff, 2026-05-25 deviation
audit).

- Research-backed age priors in `getSleepCyclePrior(ageMonths)`,
  centralized in `src/lib/types.ts`. Means anchored to the pre-existing
  age-default ladder (50 / 50 / 55 / 60 / 60) so the prior-mean path —
  which `predictNapEndTime`, `predictNightEndTime`, and the late-wake
  re-anchor all read via `getSleepCycleMinutes(ageMonths)` — doesn't
  shift baseline behavior. Ranges and SDs derive from Lopp/Jenni
  (±2.4 at 9mo), widened so data can overwhelm the prior.
- `collectCycleNapSamples` reads strict `woke_by === "self"` only from
  the new long-horizon `ctx.cycleSleeps` (180 days, fetched in
  `src/lib/server/state.ts`). Off-days excluded. Soft regime weight
  (1.0/0.5/0.2 by dominant-nap-count delta) and recency weight
  (0.5..1.0 across *sample-bearing* days, so woken cap-respect days
  don't push self-wakes "into the past"). Backtest harnesses
  (`backtest.ts` + `intraday-backtest.ts`) populate `cycleSleeps` too
  so MAE numbers validate the production data flow.
- Prior-weighted Gaussian log-likelihood scoring with multi-cycle fit
  (k ∈ {1,2,3}), mild multiplicity discount (α=0.2), residual cap at
  4σ (capping rather than rejecting prevents the prior penalty from
  scoring artificially well at candidate-range edges).
- Confidence gates: low when effective N < 5 OR aligned-std > σ × 1.25
  OR per-sample margin < 0.10 (was 0.05; Codex pushback). High
  requires N ≥ 12, ambiguity ≥ 0.15/sample, AND (within prior σ OR
  very-tight residuals ≤ σ × 0.5 AND per-sample margin ≥ 0.30 over
  prior-mean candidate). Medium otherwise. Source = "age-default" when
  confidence is low, "learned" otherwise.
- `Prediction.learnedSchedule.sleepCycle: SleepCycleEstimate` added
  alongside the legacy `sleepCycleMin: number` shim. UI cycle-nudge
  banner labels "lærte syklus" only when `source = "learned" &&
  confidence !== "low"`, else "typisk syklus for alderen".
- NapBudget cap-cycle math + rescue thresholds keep using the
  numerical `.minutes` regardless of source/confidence — only the UI
  label hedges.
- Memoized via `ctx._sleepCycleEstimate`. Type centralized in
  `types.ts` so no `unknown` cast needed in the engine.
- Tests: `tests/unit/cycle-estimator.unit.ts` follows the
  table-driven render+snapshot pattern from `docs/testing.md`: a
  single 14-scenario inline snapshot covers spec + adversarial
  fixtures (Halldis-shape, learned, very-tight high, 111m alias
  guard, uniform noise, bimodal, off-day exclusion, missing-wake
  filter, mixed regime, age boundary, long 180m, 12-24mo edge, cap-
  respect invariance) with invariants pinned below to protect every
  important behavior against `--update-snapshots`.
- Backtest snapshots are UNCHANGED end-to-end — the apparent drift
  during development came from accidentally shifting the age-default
  cycle ladder (3-6mo 50→52, 24+mo 60→65), not from the new
  estimator. Final priors keep the ladder identical.

Stage-2 followups (parked, captured by Codex deviation review):
- Drop the legacy `sleepCycleMin: number` field from
  `Prediction.learnedSchedule` after at least two release cycles.
  `timer-state.ts:117,143` still reads the scalar directly (with
  `?? 45` fallback); migrate to `sleepCycle?.minutes ?? sleepCycleMin
  ?? 45` first, then remove the scalar with a schema/cache
  compatibility window.
- A dedicated `estimatePhaseShiftCycleMin(ctx)` for the late-wake
  re-anchor only if/when we want it to use medium/high learned
  cycles instead of the conservative age-default. Today the re-anchor
  at `schedule.ts:260` deliberately stays on age-default.
- Optional absolute-time recency factor on top of sample-bearing-day
  recency, to downweight stale pre-transition evidence even when no
  newer self-wakes have logged. Would require threading `now` into
  `collectCycleNapSamples`.
- The `censorCutShortNaps` fallback-to-unfiltered loophole when
  `stableMedianMin` has < 3 samples (`schedule.ts:1188`) was noted in
  the original followup as a cycle-estimation correctness issue; the
  new sample collector is independent so the loophole no longer
  affects cycle math, but it still affects duration learning — worth
  a separate followup if/when it bites.
- Memoization-with-cloned-ctx latent risk: `state.ts` does
  `{ ...ctx, customNapCount: remaining.length }` in the re-plan path.
  If a future code path calls the estimator on that clone, it would
  return the cached estimate computed against the original
  `customNapCount`, which affects regime weighting. Currently no path
  triggers this, but if it ever does, switch to a per-call
  WeakMap<BabyContext, SleepCycleEstimate> instead of an on-ctx
  field.

**Research citations** (Codex 2026-05-20 — kept for posterity):
- Lopp et al. 2017, *Developmental Changes in Ultradian Sleep Cycles
  across Early Childhood* — Jenni et al. cited at mean cycle duration
  **57.5 ± 2.4 min at 9 months**.
  <https://journals.sagepub.com/doi/10.1177/0748730416685451>
- Grigg-Damberger 2016, *The Visual Scoring of Sleep in Infants 0 to
  2 Months of Age* — healthy term infant cycles 50–60 min.
  <https://pmc.ncbi.nlm.nih.gov/articles/PMC4773630/>
- Akacem et al. 2015 — nap duration is NOT a clean multiple of
  intrinsic cycle length; parental/environmental factors dominate.
  <https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0125181>
- SHINE 2020 — parent-reported day sleep overestimated by 29-31 min
  vs actigraphy.
  <https://academic.oup.com/sleep/article/44/4/zsaa217/5937496>

## Test-suite tightening — 2026-05-25 codex audit (mostly shipped)

Source: 2026-05-25, after the nap-budget cap-collapsing bug (commit
`f1d8783`). The bug was a dimensional confusion in `computeNapBudget`
that the existing unit suite failed to catch despite "passing" 39/41
tests on the area. Codex audited the engine test files with critical
eyes; the findings below are the highest-leverage ones.

Read this with [`docs/testing.md`](./testing.md) — the goal is not
more assertions, it is testing patterns that catch regressions while
keeping tests readable as behavior documentation (renderer + snapshot
+ pinned invariants).

**Shipped 2026-05-25 → 2026-05-26** (commits `9145681`, `0de9a94`,
`0966070`, `d0d2cb8`, `e79de0b`, and the napbudget-pauses pass):
`if (out)` guards stripped from `nap-budget.unit.ts`; Halldis real
fixture pinned with concrete cap/mode/urgency; cycle-estimator alias
exact-pins; nap-budget Gate 4 boundary; `computeBankedToday` local-
midnight fallback; active-nap-before-wake-anchor branch; two-cycle
first-contact invariance trail; multi-day capped-naps simulation;
state-level anti-ratchet closed loop; opt-in/opt-out wire-up
strengthened. One more `if (out)` no-op fixed in the off-day-bucket
expansion test (2026-05-26 napbudget-pauses pass).

### Still open

- **Aggregate snapshots hide per-day regressions**: `backtest.unit.ts`
  :72/:93/:111/:141 and `baselines.unit.ts` :62/:73 freeze multi-day
  MAE / accuracy totals. A user-visible "wake at 30 instead of 60"
  regression disappears inside 138-day aggregates. Pair the aggregate
  snapshots with at least one per-day expected behavior for the
  canonical scenarios that have repeatedly broken.
- `schedule.unit.ts:159/:176/:182/:638` — direction-only assertions
  ("after wake", "before bedtime") and "learnedDurationMin > 95"
  miss off-by-30-min regressions on the user-visible nap end.
- Cycle estimator filters: `woke_by === "self"` and duration
  `20..180` — boundary values (19, 20, 181) untested.
- Cycle estimator source precedence: `cycleSleeps → trendSleeps →
  extendedSleeps → recentSleeps` is fall-through, but no test asserts
  the precedence order.

### Process notes (durable)

- Don't pin every value exactly. Pin invariants (monotonicity,
  bounds-of-reason, no-overshoot, mode-once-set) and let the
  snapshot/trail catch the rest. Update the snapshot when behavior
  changes intentionally.
- Renderer-first: when a test asserts more than two fields, consider
  a trail/renderer + `toMatchInlineSnapshot`. The diff communicates
  the change more honestly than five separate `expect()`s.
- `if (out)` is almost always a smell. Decide which side of the gate
  the scenario lives on.

## Split `shortThreshold` into three semantically distinct thresholds

Source: 2026-05-24 Codex pair-review on the Halldis "second nap at 17:02"
bug. The bedtime-feasibility gate now stops doomed comeback naps from
surfacing (`derivePostPlanFields` rejects fallbackNextNap that can't fit
before `bedtime − 0.5 × age-band min WW`, age-aware; chosen after a
two-fixture empirical sweep — see `local/sweep-comeback-thresholds*.ts`
for the methodology). But `computeShortNapThreshold(L, C) = L − 0.5*C`
is doing three jobs in one number:

1. **Cut-short / continuation flag** — "this nap was so short the parent
   may want to extend it now." Real threshold: roughly ≤ 1 cycle.
2. **Quota sufficiency** — "did this nap fulfill the day's nap budget?"
   Today's 84 min vs 115 min learned reads as "no" even though it's a
   normal-shaped 1-nap day. Should be looser, age- and history-aware
   (e.g. ≥ 60 % of learned AND ≥ age-band floor).
3. **Recovery-plan trigger** — "should the engine plan a comeback?" Now
   gated by bedtime feasibility downstream, but the underlying signal is
   still "was this short?" rather than "is a recovery feasible AND
   pedagogically right?".

The cleanest refactor splits these into three thresholds (or a small
`napAdequacy(s, ctx)` helper returning `{ cutShort, fulfilledQuota,
recoveryWarranted }`). Today the same number drives all three call
sites: `countSufficientNaps`, `mostRecentCutShort`, `detectRescueNap`.

Land this when the next nap-budget v2 / cycle estimator v2 work touches
the same code — tying it to one of those refactors avoids a third
in-flight thread.

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

- ~~**Active nap-budget ignores pauses.**~~ Shipped 2026-05-26.
  Active-nap side is moot after the pause-redesign (naps no longer
  pause). Overnight side fixed: `computeBankedToday` now subtracts
  `calcPauseMs(s.pauses)` from each night contribution, and
  `assembleState` attaches `wakingsAsPausesForSleep` to all engine
  entry windows (recent/strategy/trend/cycle, not only today). Codex
  pair-review caught a malformed-waking blocker — `wakingsAsPauses-
  ForSleep` now clips waking intervals to the containing sleep so an
  open waking on a closed night caps at sleep.end_time instead of
  reaching `Date.now()`. Bonus: fixed an `if (out)` no-op in the
  off-day-bucket-expansion test that masked a synth-night /
  yesterdayNight start_time collision.

- **Trend classification still uses gross-duration on nights with
  pauses.** Codex 2026-05-26 follow-up to the pauses fix above.
  `computeBlendedTrend` is already pause-aware via `getWeekStats` →
  `durationMinutes` (`src/lib/engine/stats.ts:30-33`). But
  `classifyTrendDay` in `src/lib/engine/trend.ts:259-260` and `:285`
  uses a local `durationOf` (`:314-317`) that ignores `s.pauses`. A
  night with 60 min of wakings counts at full duration for
  classification — `nearTarget = totalMin >= reference - tolerance`
  may flip `policy-affected` ↔ `natural` because of waking time
  rather than actual sleep. After the bankedMin fix the cap-firing
  comparison is now pause-aware on both sides, so this is a
  classification consistency issue rather than a load-bearing engine
  bug. Cleanest fix: have `durationOf` net pauses (or delete it and
  call into the shared `durationMinutes`). Snapshot churn risk for
  trend-target diagnostics — pin the new totals deliberately.

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

- **Scattered policy literals.** (The two dead constants are resolved:
  `CYCLE_NUDGE_WINDOW_MIN` was deleted; `FIRM_PUSH_LEAD_MIN` is now
  load-bearing in `notification-scheduler.ts` instead of a literal `5`.)
  Still open: many policy thresholds (25-min continuation, 30-min rescue
  delay, 3-h horizon, 60-min stale, 18-h skip guard, 12-h overnight) live
  as literals in `src/lib/engine/state.ts`. Consolidate into `constants.ts`.

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
exported). To actually measure whether the 60-min cap helps, the fixture needs
real target_bedtime periods.

**2026-06-11 prod-pull findings** (fresh openclaw Halldis db, 1464 events,
2026-03-22 → 06-10, saved to `local/imports/halldis-openclaw.db.sqlite`):
- `target_bedtime` is a **baby-global** setting (column on `baby`), NOT
  per-day. From the `baby.updated` event log it was **`18:00` from 2026-04-05
  to ~2026-05-03/04**, then cleared (currently `null`). So a faithful fixture
  must **walk `baby.updated` events** and stamp `target_bedtime` per-day across
  that window — `db-to-fixture.ts`'s "current value applied uniformly" path
  yields nothing now that it's null (the script's own comment flags this).
- **Blocked by tooling bugs below** — the export path crashes on the current
  (migrated) schema before we can even regenerate. Fix those first, then add
  event-walking, then re-run `backtest:report` to measure the cap over the
  Apr–May 18:00 window.

## Fixture-export tooling — shipped 2026-06-11 (shared loader)

The three DB→`DayRecord` paths (`db-to-fixture.ts`, `merge-fixtures.ts`,
`backtest-report.ts --db`) each carried their own copy of the loader and the
same two bugs. Collapsed into one shared module `scripts/lib/db-to-days.ts`
(unit-tested in `tests/unit/db-to-days.unit.ts`):
- Reads night wakings from `night_waking` (the dropped `sleep_pauses` no
  longer crashes it) and nets them via the engine's own
  `wakingsAsPausesForSleep`, so fixture pause semantics match prod exactly.
- Walks `baby.updated` events into a per-day settings timeline
  (`loadSettingsTimeline` / `effectiveSettings`): a change takes effect on
  its local-date inclusive, carried forward, last-wins for same-day changes.
  `target_bedtime` is now stamped with the value that was actually in effect
  (Halldis: 18:00 on 2026-04-05 → 05-03). `--db` MAE is sane again (nap 40.9,
  wake 28.6 vs the old 1181/1279).
- `off_day` carried through. In-progress days and wake-time-less days skipped.

Open from this work:
- **Per-day `customNapCount` not threaded.** The timeline walks it, but
  `DayRecord` has no per-day `custom_nap_count` field (backtest takes it as a
  global option), so historical nap-count changes (Halldis toggled it in late
  March) aren't replayed. Cheap to add (`DayRecord.custom_nap_count` +
  `ctx.customNapCount = day.custom_nap_count ?? customNapCount` at
  `backtest.ts:195`) — do it if a nap-count-transition window ever needs
  faithful replay.
- **Don't bake `target_bedtime` into the canonical descriptive fixture.**
  Measured 2026-06-11: stamping the real 18:00 target over the Apr5–May3
  window makes *bedtime MAE worse* (32.5 vs 23.0, bias +28) — the family went
  to bed *earlier* than the 18:00 ceiling, so the prescriptive cap pulls
  predictions later than the already-well-calibrated natural prediction
  (bias −1.9 without). Descriptive MAE is the wrong yardstick for a
  prescriptive target. So `tests/fixtures/halldis-sleep.json` stays
  target-free for clean accuracy regression; intervention efficacy belongs to
  the stateful **"Backtest harness doesn't replay `TrendTargetState`"**
  followup (trend-split section above) — that harness should carry the
  per-day target from `db-to-days` and measure target-following, not MAE.
  `db-to-fixture.ts <db>` now produces the target-stamped fixture on demand
  for that analysis.

## Newborn stage: drop night/morning framing, treat as naps + wakings?

Source: 2026-06-11 — Umi parent on the pre-night_waking build logged an
evening re-sleep ("wake at 22, then sleep again") that the old version
rendered confusingly. Open question: in the newborn/emerging strategy, should
the engine stop imposing a hard "night" / "morning" / day-boundary at all and
just model naps + wakings, since newborn sleep is polyphasic and the wall-clock
day/night split doesn't apply yet?

Prior leaning was "not worth it." **Reopened 2026-06-11** — after a second
round of newborn pain (Umi parent couldn't model an evening re-sleep at all;
the operator confirmed "it's a bit confusing to use the app with a newborn"
and explicitly asked to rethink newborn mode). So this is now an active
design unit, not a parked question. Design pass (Codex) pending; the open
direction is whether the newborn/emerging strategy should drop the hard
night/morning/day-boundary and model the evening as naps + wakings, while
still deriving night totals / longest-stretch from the data rather than from
a wall-clock gate. Tie this to the **wall-clock day-boundary** followup
(`getHours()` deep-night/evening gates) — that's the concrete mislabel path.

Shipped 2026-06-11 as the immediate de-confusers (commit after this entry):
- **Add a night waking after the fact.** There was no UI to log a waking
  retroactively — the only creation path was the live 🌙 toggle during an
  *active* night (`handleNightWakingToggle`, stamps "now"). Newborn parents
  reconstruct the night next morning, so this was a dead end.
  `NightWakingEditSheet` now has a create mode (`create={{babyId,
  defaultStart}}`); a "🌙 Legg til nattvaking" button on completed night
  sleeps in `EditSleepModal` (wired on dashboard + history) opens it and
  emits `night_waking.started` + `.edited`.
- **Guard end-before-start.** `EditSleepModal` and `NightWakingEditSheet`
  now reject an end at/before start (`isEndAtOrBeforeStart`) — the slip that
  made Umi's night end before it began (end time saved on the start's
  calendar day). `ManualSleepModal` already had this.

Remaining edges from that UI work:
- A waking created on a *past* night via history optimistically lands in
  `todayNightWakings` (the only client list); it shows correctly after the
  next `/api/state` fetch and the engine nets it by time-overlap regardless,
  but the optimistic display is today-scoped. Tighten only if it confuses.
- No E2E for the add-waking flow yet (the `started`+`.edited` projection is
  covered by `tests/integration/night-waking.test.ts`; the new surface is the
  create-mode form + button wiring).


### 2026-06-12: prod-data investigation — fragmented nights corrupt newborn metrics

Pulled Umi's prod db (`local/imports/umi-data.db`, ~5 weeks old) to ground
the redesign. She logged two consecutive nights with **two different models**:
- 10→11 Jun, *intended* model: one `night` 23:00→07:00 (480m) + a
  `night_waking` 02:00–03:00.
- 11→12 Jun, *fragmented* model: three `night` rows 23:00→00:25, 00:56→04:29,
  05:05→open, with ~30-min awake gaps — i.e. several nights instead of one.

**Root cause of fragmentation:** the parent never picks nap/night — type is
auto-assigned by clock in `classifySleepType` (before 06:00 ⇒ `night`). The
intended path for a mid-night feed is the 🌙 Nattvaking button (logs a
`night_waking` inside the open night). But tapping **Vakne** (end) then
**Sove** later auto-types the next sleep as `night` again ⇒ a second night row.
So fragmentation is the natural result of using the main button for a waking.

**What it corrupts (measured on real data):**
1. **`longestStretch` is logging-model-dependent.** `computeRollingSleepStats`
   (`features.ts:265`) uses raw `end−start` per episode and ignores `pauses`:
   consolidated night ⇒ **480m** (the 02:00–03:00 waking is *not* netted out,
   over-counts); fragmented night ⇒ **213m** (only the biggest segment, the
   ~5h consolidation is invisible). Same behaviour reads ~2× different — and
   this is the headline newborn metric ("is she sleeping longer at night?").
   Confirmed by Codex: newborn rolling/trend helpers ignore pauses
   (`features.ts:265`, `:70`).
2. **24h total double-counts overlaps.** Reported `totalSleep24h`=**821m**; an
   overlapping `night` 05:00→07:00 inside the 480m night injects ~110m phantom
   (real ≈711m). No interval-merge anywhere.
3. **Two longest-stretch impls disagree.** `stats.ts:getLongestNightStretches`
   *does* net wakings but operates per night-row and groups by start-date, so
   the fragmented night splits across two calendar dates (85m on the 11th,
   213m on the 12th) ⇒ stats graph shows two artificially-short nights. And
   `stats-view-utils.ts:784,977` maps `pauses` away, so charts ignore wakings.
4. Single `priorOvernightSleep` fetch (`server/state.ts:85`, `ORDER BY end_time
   DESC LIMIT 1`) picks only one fragment ⇒ home "Søvn i dag" undercounts.

**Time-sensitive:** newborn strategy is `ageWeeks < 6` (`strategy.ts:77`). Umi
is 5w now, so within ~1 week she moves to `emerging_rhythm`, where schedule
learning treats each `night` row as an independent bedtime/night-duration/wake
sample (`schedule.ts:977`, `:1815`, `:1860`) — fragmented nights will then
pollute learning, not just the context card.

**Merged recommendation (Codex + Claude independently converged):** a blend
leaning B — don't force "one long night + wakings" as *correct* for a no-rhythm
baby, and don't build a first-class multi-segment-night schema. Instead:
- **Read-side coalescing**: a pure normalizer that merges adjacent `night`
  episodes separated by < N min into one logical night with the gaps as
  derived `pauses`, applied before metrics. Both logging models then converge
  to the same numbers. `SleepEntry.pauses` already exists; `nap-budget.ts:290`
  already sums night fragments in a 12h window as precedent.
- **Make newborn `features.ts` duration math pause-aware** (must pair with
  coalescing, else the consolidated model keeps over-counting).
- No event rewrites, no schema change, no forced retro-edits. Later extend to
  `stats-view-utils.ts` so charts stop dropping wakings.

Smallest first unit: the read-side coalescer + pause-aware `features.ts`
longest-stretch/rolling helpers, with a multi-day test asserting the two
logging models produce identical `longestStretch`/`totalSleep24h`.

**Shipping plan (one commit per unit, Codex-reviewed):**
- ✅ **Unit 1 — pause-aware newborn metrics.** `features.ts`
  `computeRollingSleepStats`/`computeLongestStretchTrend` now net wakings out
  of the 24h total and compute `longestStretch` as the longest segment between
  pauses (`longestSegmentMin`). Open wakings (`resume_time: null` on an active
  night) resolve to now; overlapping wakings are merged so they can't
  double-count. Benefits emerging too (shared helper). Codex review caught the
  open-waking + overlap edges before commit.
- ✅ **Unit 2 — overlap-safe 24h total.** `computeRollingSleepStats` now unions
  asleep sub-intervals (episode minus pauses, clipped to the window) instead of
  summing per-episode, so two *separate* overlapping rows (Umi's id5 480m night
  containing the id7 05:00→07:00 night) count once. `episodeCount`/
  `meanEpisodeDuration` stay per-row (documented on `RollingSleepStats`).
- ✅ **Unit 3 — read-side coalescing.** `coalesceNightFragments` merges adjacent
  `night` rows with an awake gap < `NIGHT_COALESCE_GAP_MIN` (60m) into one
  logical night, gaps becoming derived pauses; applied at both the newborn
  (`predictNewborn`, all metric inputs) and emerging (`predictEmerging`,
  display metrics only) engine entries. Invariant test pins that fragmented and
  consolidated logging yield identical `longestStretch`/`totalSleep24h`.
  Verified on Umi's prod db: episodeCount 11→9, total unchanged (sleep-
  preserving). Codex confirmed open-fragment safety, the 60m threshold,
  identity inheritance, and that `computeExpectedDuration` needs no change.

Deferred (not in these three units):
- Extract ONE shared pause/segment helper for `features.ts` + `stats.ts`
  (`getLongestNightStretches`) once null-resume/overlap semantics are locked —
  Codex flagged the two parallel impls can drift.
- Stats page (`stats-view-utils.ts:784,977`) maps `pauses` away, so historical
  charts still ignore wakings — extend after the engine units land.
- Single `priorOvernightSleep` fetch (`server/state.ts:85`) undercounts a
  fragmented morning night in "Søvn i dag".
- Emerging/`schedule.ts` learning still treats each `night` row as an
  independent bedtime/duration/wake sample — coalescing the learning inputs is
  a bigger, separate unit.


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
