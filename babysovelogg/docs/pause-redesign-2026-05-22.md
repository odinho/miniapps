# Pause UX redesign — 2026-05-22

Source: design pass with user 2026-05-22, in dialogue with a parallel
Codex review. Replaces the current single `Pause` button (which
collapses two unrelated use cases) with two distinct affordances.

## Problem

`⏸️ Pause` exists in part because `End` is one-way: a parent unsure
whether baby is really awake will pause rather than commit to End,
because End has no resume. So pause is doing two unrelated jobs:

1. **Tentative end** — "I think she's awake but might go back; capture
   the time now in case I don't get back to the app." This is the
   real reason parents reach for pause on naps.
2. **Mid-sleep waking** — "Baby woke at 03:15 inside the night sleep,
   went back at 03:32, want it recorded as a thing that happened."
   This is what Napper calls a night-waking.

Both jobs are served poorly today:

- The button label tells you neither.
- The arc center shows `⏸️ Pause` instead of anything legible.
- Completed pauses are invisible on the arc (no red interval,
  unlike Napper). Imported Napper `NIGHT_WAKING` entries already get
  stored as pauses — and stay invisible.
- Pauses cannot be edited from the homepage. They are child rows on
  the parent sleep with no edit sheet — biggest single source of
  user frustration ("I just want to click the red part in the circle
  and adjust it").

## Goals

- Naps: parent can commit to End and still recover if baby goes back
  to sleep within a short window. No `Pause` concept.
- Nights: night wakings are first-class events with their own edit
  sheet (start, end, notes, mood). Click the red interval on the
  arc → edit it.
- Schema gets *simpler*, not more elaborate, on net. `sleep_pauses`
  goes away.

## Non-goals

- Multi-day editing UI for wakings (use existing history scrolling).
- A separate `night_waking_event.tagged` flow — fold notes/mood into
  the `night_waking.edited` payload.
- Reasoned/typed pause categories ("medical", "feeding", etc.) —
  rejected as premature modeling.

## Design

### Naps — reversible End, no pause

Tap `Vakna` (rename from current `End`/`Vakna` flow as appropriate) →
sleep ends at now, `WakeUpSheet` opens as today.

Inside `WakeUpSheet` (and `SleepEditSheet`, reachable from the
history list and from clicking the nap on the arc), when:
- the sleep was a `nap`,
- `end_time` is within ~15 min of now,
- no later sleep has been started,

show an `Angre slutt — søv vidare` button. Tap → emit
`sleep.end_undone` (clears `end_time`, sleep becomes active again).

After the 15-min window, the button no longer renders. No toast
layer required — the entry points to these sheets (homepage `Vakna`,
history click, arc click) already exist.

If baby actually went back to sleep and the parent didn't undo in
time, they start a new nap. The engine already handles short-gap
nap continuations.

### Nights — `night_waking` as a first-class event

New table:

```sql
CREATE TABLE night_waking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baby_id INTEGER NOT NULL REFERENCES baby(id),
  domain_id TEXT NOT NULL UNIQUE,
  start_time TEXT NOT NULL,
  end_time TEXT,
  notes TEXT,
  mood TEXT,
  created_by_event_id INTEGER NOT NULL REFERENCES event_log(id)
);
CREATE INDEX night_waking_by_baby_start ON night_waking(baby_id, start_time);
```

Events:

- `night_waking.started { babyId, startTime, wakingDomainId }`
- `night_waking.ended { wakingDomainId, endTime }`
- `night_waking.edited { wakingDomainId, startTime?, endTime?, notes?, mood? }`
- `night_waking.deleted { wakingDomainId }`

Homepage:

- During an active **night** sleep, the existing pause button slot
  becomes `🌙 Nattvaking`. Tap → emits `night_waking.started`.
- While a waking is open, the button becomes `Sov att` (emits
  `night_waking.ended` with `now`).
- Arc center label, while a waking is open:
  `Vakning sidan 03:15`. Resumed night sleep keeps showing
  `💤 Søv` with the waking interval already shaded red.
- After the waking ends, the night sleep continues without
  interruption — its band still grows.

Arc:

- Inside the active and completed night bands, overlay completed
  `night_waking` intervals as red sub-bands.
- Click the red sub-band → opens `NightWakingEditSheet` (new
  component, modelled on `SleepEditSheet`) with: start/end pickers,
  notes textarea, mood emoji picker, delete button.

History:

- Each night entry lists its child wakings as indented sub-rows:
  `🌙 Vakning · 03:15–03:32 (17m) [notes]`.
- Click a sub-row → opens `NightWakingEditSheet`.
- Replace today's `1 pause (5m)` meta line with the indented rows.

Engine:

- Night-sleep duration math subtracts overlapping `night_waking`
  intervals (replaces `calcPauseMs(...)` on night sleeps).
- Total night sleep in stats: same.
- Prediction code paths that consume pause data: audit and
  re-point to the new query.

### Naps and pauses

After this redesign, **naps never have pauses**. The
`isPaused`/`pauseTime` plumbing on `arcActiveSleep`, `TimerInput`,
and `Timer.svelte` simplifies accordingly.

## Migration

One-shot replay on first boot after deploy (in projections rebuild,
or as a dedicated migration in `src/lib/server/db.ts`):

```text
For every existing sleep_pauses row:
  if parent sleep.type == 'night':
    INSERT INTO night_waking(baby_id, domain_id, start_time, end_time, notes=NULL, mood=NULL, created_by_event_id)
      using the parent sleep's baby_id, a fresh domain_id, the pause row's pause_time/resume_time, and the original created_by_event_id.
  if parent sleep.type == 'nap':
    if pause_row.resume_time IS NOT NULL:
      drop (its duration was already invisible to UI).
    else:
      treat as a tentative end — set parent sleep.end_time = pause_row.pause_time if not already set; drop.
Then DROP TABLE sleep_pauses.
```

Old `sleep.paused` / `sleep.resumed` / `sleep.pause_deleted` events
in `event_log`: the projection re-becomes a no-op (event preserved
for audit; projection rebuild skips it). A `sleep.end_undone` event
must replay deterministically — it clears `end_time` only if the
projected sleep currently has a non-null `end_time`.

Napper imports (`src/lib/server/import-napper.ts`): replace the
`sleep.paused`/`sleep.resumed` emission for `NIGHT_WAKING` with
`night_waking.started`/`night_waking.ended` emissions tied to the
parent night by `babyId` + timestamp window.

## Implementation stages

Order matters — keep each stage shippable on its own.

1. **Stage 1 — `Angre slutt` button via existing `sleep.restarted`.** *Shipped 2026-05-24.*
   - Discovery: `sleep.restarted` event + projection + offline-queue
     handling already existed (used by the post-End undo toast).
   - Added `src/lib/end-undo.ts` with `isWithinEndUndoWindow()` —
     pure gating: nap + within 15 min + no later sleep.
   - Added `Angre slutt — søv vidare` button in
     [`WakeUpSheet.svelte`](../src/lib/components/WakeUpSheet.svelte)
     and [`EditSleepModal.svelte`](../src/lib/components/EditSleepModal.svelte),
     gated by the helper. Tap → emits `sleep.restarted`.
   - `buildEndSleep` now stamps `end_time` onto the returned
     `sleepSnapshot` so downstream consumers see post-end state.
   - Tests: `tests/unit/end-undo.unit.ts` (8 cases), `tests/end-undo.e2e.ts`.
   - No pause changes yet — the existing pause button stays around.

2. **Stage 2 — `night_waking` table, events, and projections.**
   - New table, schema, four event types, projection handlers.
   - Rebuild logic updated; no UI yet.
   - Migration: copy existing `sleep_pauses` rows on night sleeps
     into `night_waking`. Leave `sleep_pauses` in place for now —
     this stage is data-prep.
   - Tests: integration for event → projection round-trip; rebuild
     idempotency.

3. **Stage 3 — Night waking UI: button, arc rendering, edit sheet.**
   - Homepage button switches based on active sleep type
     (`nap` → `Vakna no` only; `night` → `🌙 Nattvaking` / `Sov att`
     when a waking is open).
   - Arc renders red sub-bands inside night sleeps.
   - New `NightWakingEditSheet`. Wire click handlers from arc and
     history.
   - History indented sub-rows for night wakings.
   - Tests: e2e for the full night-waking flow.

4. **Stage 4 — Remove pause on naps; clean up.**
   - Drop pause button code paths on naps in `+page.svelte`,
     `arc-utils.ts`, `timer-state.ts`, `WakeUpSheet.svelte`.
   - Migration finalization: convert any remaining nap `sleep_pauses`
     rows (per the rules above), then `DROP TABLE sleep_pauses`.
   - Mark `sleep.paused` / `sleep.resumed` / `sleep.pause_deleted`
     schemas deprecated (projection becomes a no-op preserving the
     audit trail).
   - Delete `calcPauseMs`, `buildPause`, `buildResume`,
     `isPaused`, and the `pauses?: SleepPauseRow[]` field on
     `SleepLogRow` (or scope to night-derived, depending on Codex
     simplification review).
   - Update `import-napper.ts` to emit `night_waking.*` events.
   - Tests: delete `tests/pause.e2e.ts`; add or extend
     `tests/night-waking.e2e.ts`.

5. **Stage 5 — Polish.**
   - History sub-row styling.
   - Arc red sub-band styling (dark-mode contrast, accessibility).
   - Settings: optional toggle for "track night wakings" if we want
     to mirror the diaper-toggle pattern (not required; lean toward
     always-on).

## Simplification opportunities

Touchpoint inventory (Codex review, 2026-05-22). Each gets deleted
or rewritten in stage 4 unless noted:

- [`src/lib/sleep-actions.ts:56`](../src/lib/sleep-actions.ts) —
  `buildPause` / `buildResume` / `isPaused` all delete.
- [`src/lib/timer-state.ts:73`](../src/lib/timer-state.ts) —
  the `isPaused`/`calcPauseMs` branch in `getTimerMode` simplifies:
  active sleeps always count elapsed from `start_time`. Night-sleep
  elapsed subtracts overlapping night-waking intervals via a new
  helper (`subtractWakingMs(sleepId, now)` or similar).
- [`src/lib/arc-utils.ts:167`](../src/lib/arc-utils.ts) — the
  `isPaused`/`pauseTime` branch in `collectBubbles` disappears.
  Active sleeps grow to `now` unconditionally. Night-waking
  intervals overlay as a separate render pass on the arc.
- [`src/routes/+page.svelte:15`](../src/routes/+page.svelte) —
  drop `buildPause` / `buildResume` / `isPaused` imports,
  `pauseBusy`, `paused` derived, `handlePauseToggle`. Replace the
  arc-action-btn with a context-switched button that emits
  `night_waking.started`/`ended` on night sleeps and is hidden on
  naps.
- [`src/lib/components/WakeUpSheet.svelte:20`](../src/lib/components/WakeUpSheet.svelte) —
  the `trailingPause` block (lines 20–105 and 185–190) deletes
  entirely. The "wake time defaults to pause time" affordance is
  no longer needed because naps don't pause; the parent commits
  to End and undoes within 15 min via the new
  `Angre slutt — søv vidare` button.
- [`src/lib/components/EditSleepModal.svelte:118`](../src/lib/components/EditSleepModal.svelte) —
  the `confirmPauseDelete` / `deletePause` / `Pauses` block
  (lines 118–300) deletes. Night wakings are edited through the
  new `NightWakingEditSheet`, not from inside the parent night's
  edit modal. (Today's modal allows *delete-only* of pauses; the
  redesign delivers full time-edit + notes via the dedicated
  sheet.)
- [`src/lib/server/projections.ts:226`](../src/lib/server/projections.ts) —
  the three case branches (`sleep.paused`, `sleep.resumed`,
  `sleep.pause_deleted`) become no-op handlers that preserve the
  event for audit but write nothing (post-migration the table is
  gone). Cleanup helpers around `sleep_pauses` (lines 405–414,
  445, 462) delete.
- [`src/lib/server/schemas.ts:108`](../src/lib/server/schemas.ts) —
  keep the three pause schemas (so historical events still parse
  during replay) but mark deprecated with a comment. Add the four
  new `night_waking.*` schemas plus `sleep.end_undone`.
- [`src/lib/server/db.ts:106`](../src/lib/server/db.ts) —
  `DROP TABLE sleep_pauses` after migration. Add `night_waking`
  CREATE.
- [`src/lib/engine/classification.ts:51`](../src/lib/engine/classification.ts) —
  `calcPauseMs` deletes. Replaced by a `night_waking`-scoped helper
  used only where night-sleep durations are computed; nap math
  stops subtracting anything.
- [`src/lib/server/import-napper.ts:128`](../src/lib/server/import-napper.ts) —
  rewrite the `NIGHT_WAKING` emission block to produce
  `night_waking.started` / `night_waking.ended` events pointing
  at the parent night's `babyId`, not `sleepDomainId`.
- [`src/routes/history/+page.svelte:142`](../src/routes/history/+page.svelte) —
  remove the `pauseInfo` line on sleep entries. Add an indented
  sub-row renderer for `night_waking` rows (click → open
  `NightWakingEditSheet`).
- [`tests/pause.e2e.ts:12`](../tests/pause.e2e.ts) — delete.
  Replace with `tests/night-waking.e2e.ts` covering the new flow.

Adjacent narrowing in `src/lib/types.ts`: drop
`pauses?: SleepPauseRow[]` from `SleepLogRow`; drop
`SleepPauseRow` and `SleepPause` types altogether.

### Migration landmines

- **Event replay across old DBs.** Schemas for the three pause
  events must stay registered or any rebuild on a pre-redesign
  DB will fail at parse time. Plan: keep the validators, make the
  projection handlers no-ops.
- **`sleep.pause_deleted` had a `pauseIndex` argument** that's
  meaningless once `sleep_pauses` is gone. The no-op projection
  ignores it; new code never emits it.
- **`sleep_log.end_time` getting cleared by `sleep.end_undone`.**
  The projection must clear `end_time` only when the current row
  has the matching `end_time` value (idempotency under replay),
  otherwise re-running the event after the parent has been
  properly ended would silently un-end it.

## Open questions

- **Do we keep the old `sleep.paused`/`sleep.resumed` event schemas
  as deprecated no-ops, or hard-remove them?** Event-sourced DBs
  with historical events would fail to replay if we hard-remove
  the schema. Recommendation: keep schema, project to no-op.
- **Multi-baby support for `night_waking`?** Same shape as
  `sleep_log`; no extra design.
- **Newborn-mode rendering.** Newborn nights are themselves heavily
  fragmented; do we render each "feed waking" as a red sub-band, or
  is that too noisy? Defer: ship the same model, evaluate visually
  on real Halldis data, possibly suppress the rendering in
  newborn-strategy mode.
