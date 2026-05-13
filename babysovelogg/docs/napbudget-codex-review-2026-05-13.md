# napBudget — Codex Closing Review (2026-05-13)

Captured at end of the build session that shipped commits `ef874e8` →
`ae1b5ea`. Codex pair-review verdict on the full feature end-to-end.
Drives the must-fix list for the next session.

## Verdict

**Not production-ready as-is.** The engine idea is coherent, but the
next user-facing release needs fixes for overdue push spam, wake-
recommendation priority, and the missing real opt-out.

Codex verification: `bun test` runs 856/856 pass. The findings below
are correctness gaps, not regressions in what's been built.

## Must-fix (next session, in priority order)

### 1. Push spam: `nap_budget_cap` fire-at lands in the past + dedupe instability

`src/lib/server/notification-scheduler.ts:105` schedules
`fireAt = wakeBy - 5 min`. When `wakeBy` clamped to `now + 1` (the
elapsed-clamp from the earlier Codex must-fix), `fireAt` is already
in the past. `fireDueNotifications` sends past rows immediately.

Worse: the dedupe key includes `wakeBy` itself, which advances on
every reconciliation. The app inserts a fresh "due now" row each
cycle for the same active nap.

Fix:
- Stable dedupe key: `nap_budget_cap:${active.domain_id}` (no
  timestamps).
- Fire immediately *once* when already inside the lead window.
- Don't reschedule if a row for the same domain_id is already queued.

### 2. No priority arbitration between wake recommendations

`napBudget` + `rescueNap` can both render in active-nap mode,
stacking two banners with different wake times. The four
`Prediction` surfaces (`rescueNap`, `continuationWindow`,
`postSkipPlan`, `napBudget`) are each correct locally but produce
conflicting guidance globally.

Codex pushed back on the full discriminated-union refactor (right
call to defer to v2), but flagged this priority gap as the real
architecture problem.

Fix: a narrow priority resolver. e.g. when napBudget is active,
suppress `rescueNap`; or when rescueNap's `recommendedWakeTime` is
earlier than napBudget's `wakeBy`, show only the earlier one.
`expectedWakeRange` is uncertainty around a prediction, not advice —
it stays separate.

### 3. Opt-out not actually wired

Both `state.ts` call sites pass `optedIn: true` hardcoded
(`src/lib/engine/state.ts:651` and `:891`). The advertised banner
opt-out doesn't exist. Only the push respects
`prefs.nap_budget_cap`.

Fix: thread the preference into `computeNapBudget`. Easiest: in the
server `state.ts`, read `getPrefs(baby.id).nap_budget_cap` and pass
it via DayData, then through ctx, then to computeNapBudget.
Alternative: a per-baby column on the `baby` table (`nap_cap_advice`)
if we want orthogonal control from notification prefs.

### 4. Bedtime-guard order undoes the past-clamp

`src/lib/engine/nap-budget.ts:175` clamps `cap ≥ elapsed + 1`, then
the bedtime guard at `:181` can shrink `wakeBy` back to
`bedtime - 90 min`. If `bedtime - 90 min < now`, the bedtime guard
re-introduces a past-wake.

Fix: swap order, or take `max(cap-after-bedtime-guard, elapsed+1)`
as a final step.

## Real concerns (worth knowing, not strictly blocking)

### Mode hysteresis isn't real hysteresis

`nap-budget.ts:138` uses `mean30 - mean7 >= 25`. After ~30 days of
cap-respect, 30d catches up to 7d and the delta trends back to zero.
"Established" mode self-terminates even though the parent is still
capping.

Two options:
- Persist `mode` in state (last-fired mode sticks until criteria
  meaningfully break it). Add `entered_at` so we know how long it's
  been active.
- Rename to "transition-to-cap mode" and accept it's temporary —
  drop the implication that this is a stable end-state.

Codex argued for memory.

### Today's-frame banked breaks on edge cases

- **Split nights**: `computeBankedToday` stops at the first
  night-ended-today. If parent logs night as two fragments
  (mid-night-wake feeding logged as separate entries), totals
  undercount.
- **Midnight-crossing naps**: a 23:40-00:30 nap is start-anchored to
  yesterday → vanishes from the new day's banked. Codex suggested
  switching to a "sleep-day anchored on morning wake" boundary,
  not midnight.
- **Day-shifted schedules**: parents whose baby naturally sleeps
  late (e.g. bedtime 01:00) hit the midnight boundary cleanly.
  Sleep-day anchor needed.

### Trend gates have age-blind thresholds

The 12% stdev/mean ceiling and 7-day min are hand-picked.
- At 13h mean, 12% allows ~94 min SD — permissive for toddlers,
  reasonable for younger babies.
- The code requires 7 complete days *in the 30d window*, not
  necessarily 7 recent complete days. Intermittent logging could
  let one or two recent days drive `mean7`.

### Sick / spurt / DST days

The variance gate fires *after* noisy data accumulates, not on the
first sick day. The off-day marker followup is more urgent than
documented — it's not a v2 nice-to-have, it's a v1 gap that hits
users on the worst day.

### Collapsed SleepInsightsCard still shows stale total

`SleepInsightsCard.svelte:93` — the trend row only helps after the
parent expands the card. The collapsed line shows the learned total
unaltered.

### `getLearnedNapDuration` chicken-and-egg

Real bug. `censorCutShortNaps` drops `woken` naps below self-wake
median (`schedule.ts:814`). Halldis can cap 30 naps and still keep
`learnedNapDuration = 120`.

Codex pushback on the v2 followup criteria as written ("day was on
trend → nap was natural" — too loose; lets failed car naps poison
learned duration). Better criteria:

> Include parent-ended last naps *near a prior budget cap*, on
> non-off-days, where the resulting day landed near trend.

Even cleaner: separate "natural duration" (what the baby self-wakes
at) from "accepted routine duration" (what the parent caps at). The
schedule engine could consume either depending on the question.

### Missing tests

- Combined `rescueNap` + `napBudget` for an active nap.
- Overdue `nap_budget_cap` push (the past-fire path).
- Bedtime-guard-after-clamp order regression.
- Split-night banked totals.
- Midnight-crossing nap.
- Collapsed `SleepInsightsCard` display.

## Confirmed working

- Today's-frame banked decision was the right call for the normal
  case (rolling 24h was worse).
- `dailyTrendTotalMin` compute cost is negligible.
- Trend gates fire correctly on the Halldis fixture
  (`tests/fixtures/halldis-real-2026-05-13.json`).
- Deferring the `WakeRecommendation` discriminated-union refactor
  was the right call given regression risk.

## Architecture stance Codex would defer / agree with

- **Defer**: discriminated-union refactor (already in
  `followups.md`).
- **Agree**: the four wake-recommendation fields are awkward but
  not the most pressing problem — the *arbitration* between them is.
- **Reframe**: `expectedWakeRange` is uncertainty around a
  prediction, not advice. It stays out of any future
  `WakeRecommendation` union.

## Files touched in this critique window

Engine / state:
- `src/lib/engine/nap-budget.ts`
- `src/lib/engine/state.ts` (lines 644, 605, 881, 855)
- `src/lib/engine/constants.ts` (`NAP_BUDGET`, `NAP_FLOOR_BY_AGE`)
- `src/lib/stores/app.svelte.ts` (`Prediction`, `NapBudget`,
  `dailyTrendTotalMin`)

UI:
- `src/lib/components/SleepInsightsCard.svelte`
- `src/routes/+page.svelte` (nap-budget-banner around line 562)

Notifs:
- `src/lib/server/notification-scheduler.ts` (nap_budget_cap branch
  around line 92)
- `src/lib/server/notification-prefs.ts`
- `src/lib/notifications.ts`

Tests:
- `tests/unit/nap-budget.unit.ts` (24 tests + real Halldis fixture)
- `tests/unit/notification-scheduler.unit.ts`
- `tests/unit/state.unit.ts`
- `tests/unit/timer-state.unit.ts`

Docs:
- `docs/sleep-science-research.md` §12 (evidence base)
- `docs/architecture.md` (Wake-time recommendations + Trend math)
- `docs/agent-guide.md` (Wake-recommendation change path)
- `docs/followups.md` (v2 refactor + dynamic woke-reason inference
  + sick/travel marker)

## Commit chain

```
ef874e8  feat(engine): napBudget — trend-anchored nap-cap recommendation
3850638  fix(engine): gate continuationWindow on isDayOnTrend; "today's frame" banked
583385f  fix(engine): address Codex review — past wakeBy + trend gates + learned override
c9166a0  fix(insights-card): show 7d/30d trend total alongside learned
ae1b5ea  feat(napBudget): UI banner + push notification + docs
```
