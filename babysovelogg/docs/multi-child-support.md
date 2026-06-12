# Multi-child support (twins + siblings)

**Status:** planning — living roadmap, iterated across sessions.
**Started:** 2026-06-12.
**Owner doc:** this file is the durable plan. Per-unit work still flows
through [`followups.md`](./followups.md) and the
[`workflow.md`](./workflow.md) unit-of-work loop; this file holds the
multi-phase shape so we don't lose the thread between sessions.

---

## Why

A family now has **twins** — two babies of the same age tracked by the
same parents. The app is single-baby today. Separately, we want to be
able to track **siblings of different ages** (e.g. an older child logged
mostly for fun / curiosity) in the same family without forcing them onto
a shared rhythm.

So the real ask is **multiple children per family**, with a
**twin-optimised layer** on top for the same-age, same-parents case.

**Hard constraint: at most 2 children per family.** This is a deliberate
scope cap, and it simplifies the whole design — two children always fit
as two lanes / two-up views, so there is **no need for a baby dropdown or
list**, no "pick from N" anywhere. Everything is "this one, the other, or
both." Don't build for arbitrary N.

---

## Two modes (one capability)

The base capability is **multi-child** (max 2): both children in one
family DB, shown together, with per-child data and settings. On top of
that:

- **Twin-optimised affordances** light up when two tracked children are
  close in age (born within ~a few weeks): one-tap "log for both",
  combined graphs, overlap/sync views, optional schedule coupling.
- **Mixed-age / sibling mode** is the *absence* of those affordances:
  independent children, independent settings, no synchronisation
  (it wouldn't work — a 5-year-old and a newborn share nothing
  schedule-wise). It should feel like a **simpler** app, not a
  twin app with half the buttons greyed out.

> Open decision: detect twin-vs-sibling by age proximity automatically,
> ask once when adding a child, or let it be a per-family toggle. Leaning
> "infer from age gap, allow override." Resolve before Phase 3.

---

## The cardinal invariant

**Every logging action is visibly tied to one baby — or explicitly to
both.** Logging sleep on the wrong twin is the worst failure this app can
have, and a tired parent at 3am will hit it if "which baby" is hidden
state. This invariant decides the whole UX: the primary logging surface
shows both babies and scopes every action explicitly. A hidden
"active baby" mode behind the log buttons is the trap to avoid (Codex
2026-06-12, strongly).

**Resolved (user, 2026-06-12): family-first, no global switcher.** With a
max of 2 children, both are always shown together — on the home screen
AND on stats (combined / two-up). There is no app-wide "active baby"
selector. A **per-baby focus** is used only for things that are *truly
per-baby* (e.g. each child's settings, a single-baby detail/history
drill-down) and it must be **obvious** which child you're acting on. So:
both-by-default everywhere; explicit per-baby focus only where the data
genuinely belongs to one child.

---

## Architecture reality (mostly plumbing + UX, not engine)

The prediction engine is the easy part. The hard part is selection,
client state, notification routing, and the UI.

**Already multi-child-ready:**
- Every log table (`sleep_log`, `diaper_log`, `night_waking`,
  `day_start`, `notification_subscriptions`, `notification_schedule`,
  `notification_preferences`, `nap_budget_state`, `trend_target_state`)
  already carries a `baby_id` FK.
- The engine is **pure per-baby**: `assembleState(ctx)` /
  `BabyContext` describe one baby (`engine/state.ts:748`). It already
  runs correctly for two babies — just call it twice. No engine change
  needed for basic multi-child.
- Strategy selection (`engine/strategy.ts`) is age/data-driven, so twins
  (shared birthdate) land on the same strategy automatically.

**Single-baby assumptions to dismantle (the actual work):**
1. **Selection chokepoint.** `db.ts:getCurrentBaby()` and
   `state.ts:getState()` both hardcode
   `SELECT * FROM baby ORDER BY id DESC LIMIT 1`. ~10 API routes call
   `getCurrentBaby()` (sleeps, wakeups, night-wakings, diapers, export,
   import/napper, notifications/{subscribe,preferences,test}).
2. **Client state.** `stores/app.svelte.ts` holds one `baby`, one
   `prediction`, one `activeSleep`. `/api/state` returns one flat object;
   `/api/events` computes one state and broadcasts it
   (`api/events/+server.ts:84`); SSE replaces the whole thing.
3. **Optimistic sync.** `offline-queue.ts:applyOptimisticEvent()` mutates
   one flat `AppState` (`:80`). It must route events into the right
   child's slice (`babiesById[payload.babyId]`).
4. **Notifications.** Subscriptions/schedule/prefs are keyed by
   `baby_id`, but reconciliation runs against "the baby", and one parent
   device must receive correctly-attributed pushes for **both** babies
   without doubling the noise.
5. **UI.** Dashboard, history, stats, settings, onboarding all assume one
   baby. Onboarding is gated on "no baby exists".

**Known traps — must-fix, will silently corrupt data the moment a second
child exists:**
- **`baby.updated` targets the newest baby.** Projection does
  `ORDER BY id DESC LIMIT 1` (`projections.ts:20`). The event payload has
  no `babyId`. Fix at the **event schema** level (add `babyId` to
  `baby.updated`, keep replay compat for old events), not just the
  projection — otherwise edits to the first twin hit the second.
  RESOLVED: `babyId` added to the event (schema + projection +
  `buildBabyEvent`); falls back to newest only for replay of old events.
- **`day.started` timezone lookup uses the newest baby**
  (`projections.ts:371`). RESOLVED: TZ is now family-level (single-row
  `family` table); the projection reads `getFamilyTimezone()`.
- **Notification dedupe collisions.** `notification_schedule.dedupe_key`
  is globally unique (`db.ts:185`) and keys like
  `bedtime_approaching:${localDate}` (`notification-scheduler.ts:175`)
  collide across twins. Dedupe keys must be baby-scoped.
- **Subscriptions are tied to one `baby_id`** and subscribe overwrites
  the endpoint onto `getCurrentBaby()`
  (`db.ts:175`, `notifications/subscribe/+server.ts:14`) — one twin's
  subscription clobbers the other. A device must subscribe to the
  **family**, with per-baby prefs.
- **History/stats helpers call unscoped APIs** (`history-utils.ts:79`,
  `stats-view-utils.ts:784`).
- **Export/import silently target one baby** today.

---

## Design principles

1. **Single-baby is the untouched default.** A one-child family sees zero
   new chrome and identical behaviour. The switcher and twin affordances
   only appear at 2+ children. Render legacy single-baby UI when
   `babies.length === 1`. This is the regression line we protect in
   every phase.
2. **The cardinal invariant** (above): every action tied to one baby or
   both, never hidden.
3. **Twin parents are more sleep-deprived and time-poor than singleton
   parents.** Every extra tap hurts twice. Logging ergonomics are a
   first-class feature, not polish.
4. **Predict independently by default; surface overlap in the UI.**
   Coupling the babies' *recommendations* is powerful but risky (one
   baby's bad night dragging the other's schedule). Coupling is opt-in
   and late (Phase 4), never the default. Sync/cap actions are **parent
   policy, not natural evidence** — they must not teach the learner that
   the intervention is the baby's biology (ties into the existing
   `censorCutShortNaps` / trend-classification followups).
5. **Mixed-age siblings get a simpler app, not a degraded twin app.**
6. **Each phase is independently shippable** and leaves every existing
   single-baby family completely unaffected.

---

## State shape (cross-phase decision)

Adopt a family snapshot built from a per-baby assembler, keeping the
engine pure:

```ts
getBabyState(babyId, now)   // = today's getState, scoped to one baby
getFamilyState(now) -> {
  babies: [{ baby, activeSleep, staleActiveSleep, todaySleeps,
             todayNightWakings, stats, dayTotals, prediction, ... }],
  family: { bothAsleep, firstWake, nextAction, overlapWindows },
  // temporary legacy top-level aliases (single-baby UI) during migration
}
```

Rationale (Codex): SSE and offline sync need **one coherent family
snapshot** per event, so don't make the client call `getState(babyId)`
twice. `assembleState()` stays per-baby and engine tests stay clean; add
wrapper tests for family ordering, shared `now`, and SSE payload shape.
Keep `?now=` **family-wide** so both twins share the clock for
deterministic tests/screenshots.

---

## Phases

Each phase is sized at *several days* of work. Ship one unit at a time
within a phase (workflow.md loop: test → fix → validate → Codex review →
followups → commit). Don't start a phase before the prior one is solid.

### Phase 1 — Multi-child foundation: add a child + family home

**Status: LANDED (2026-06-12).** Backend family snapshot + data-corruption
guards + family-level TZ; client `babies[]` store with per-baby optimistic
routing; add-child / per-child settings; family home lanes + "begge" bulk +
per-baby focus; notifications multi-child-safe (family delivery, baby-scoped
dedupe, named pushes, per-baby prefs). E2E regression pins in place. (A Codex
review of the client+UI may still surface polish — folded into followups.)

**Goal:** a parent can add a second child; the home screen shows both and
every action is unambiguously scoped; switching to a child's detail views
works really well. This phase alone delivers the mixed-age sibling case.

> **DECIDED (user, 2026-06-12): family-first, no global switcher.** Home
> shows both babies as lanes, each with its own log buttons, plus a
> "begge" bulk row. No app-wide active-baby selector. Per-baby focus only
> for truly-per-baby surfaces (settings, single-baby detail), made
> obvious. Max 2 children, so two lanes always fit — no dropdown.

**Backend**
- `getBabyState(babyId, now)` + `getFamilyState(now)`; keep legacy
  top-level aliases for single-baby UI.
- All ~10 API routes take/resolve an explicit `babyId` instead of
  `getCurrentBaby()`. Mutations carry `babyId` in the event payload.
- Add `babyId` to the `baby.updated` event + projection (replay-compat).
- Fix `day.started` TZ lookup. **DECIDED (user, 2026-06-12): timezone is
  family-level, not per-baby.** The DB is one family (each family is its
  own deployment — `deploy/manage.sh`), so TZ lives on a single-row
  `family` table, read via `getFamilyTimezone()`, set via a new
  `family.updated` event (replay-compat from `baby.created` /
  `baby.updated{timezone}`; seeded at boot from the legacy per-baby
  column). `getBabyState` overlays it onto `baby.timezone` so every reader
  is unchanged. Rationale: in every supported case both children share one
  household zone, so a per-baby column let an *impossible* divergent state
  exist — which is exactly what made the `day.started` "newest baby" trap
  possible. One row = one source of truth = divergence is structurally
  impossible. (Babies deal only in absolute instants; TZ is purely the
  household's day-bucketing locale.) **LANDED.**
- `/api/events` broadcasts the family snapshot; `/api/state?baby=` and
  `?now=` family-wide.
- New-child creation: `baby.created` already inserts; add the
  event-emitting UI; offline-queue + projections handle N babies.

**Client**
- `app.svelte.ts` holds `babies[]` / `babiesById` (max 2); derived
  single-baby views still work for the N=1 path. No global `activeBabyId`
  — surfaces that need one child take an explicit `babyId` prop.
- `applyOptimisticEvent()` routes into the right child's slice. "Sove
  begge" enqueues **two normal `sleep.started` events** with the same
  timestamp — not a coupled row.
- Home: per the decision above. Per-baby undo **and** bulk-action undo.
- Settings: "Legg til barn"; per-child settings (name, birthdate, nap
  count, diaper, target bedtime, notifications).

**Notifications (minimum for a second child to be safe)**
- Family-device subscription; per-baby prefs; baby-scoped dedupe keys;
  push text names the baby ("Ada: luren sluttar snart"). Smart merging
  deferred to Phase 2.

**Tests**
- **E2E:** add a second child; log a sleep and assert it lands on the
  *correct* child; **edit the first child after a second exists**
  (regression guard for the `baby.updated` trap); single-baby family
  shows no new chrome; "begge" creates two correctly-scoped sleeps.
- **Fast UI/component tests** for the store (slices, active selection,
  derived views), the home lanes, and the bulk action — many small fast
  tests, not just E2E.
- Integration tests for `getBabyState`/`getFamilyState`, each route's
  babyId resolution, and the SSE payload shape.

**Shippability / regression line:** at N=1, byte-for-byte the same
experience.

### Phase 2 — Logging ergonomics + at-a-glance (the daily win)

CORE (Codex-ranked):
- Two baby **lanes** on Heim: name, asleep/awake, elapsed, next
  wake/nap/bedtime, stale warning.
- One-tap **`Sove begge` / `Vakne begge`** with immediate correction
  ("Berre Ada vakna" / "Bo søv vidare").
- Per-baby buttons stay visible — twin families need both bulk and split.
- **Morning prompt for both**: "Når vakna dei?" with a same-time default
  and per-baby adjust (today's prompt asks one baby,
  `+page.svelte:580`).
- **Combined status line**: "Begge søv. Første venta vakning: Ada om
  18 min." — matters more than two pretty arcs.
- **Sync mode vs individual mode** toggle: "Samkøyr dagen" vs "Følg kvar
  rytme".
- Night-waking flow asks which baby, then optionally "Vekte den andre
  også?" when co-sleeping/same room.

Mixed-age siblings: independent quick-log, no "begge".

**Tests:** E2E for log-for-both attribution; component tests for lanes +
combined status; fast tests for the bulk fan-out + per-baby/bulk undo.

### Phase 3 — Twin views: combined graphs, comparison, overlap

- Stats show both children by default (no switcher). **Twins**: overlaid
  in one sleep graph + combined stats. **Mixed-age siblings**: two-up /
  segmented rather than overlaid (a 5yo and a baby don't share a y-axis
  meaningfully) — combined where it's still interesting, separate where
  it isn't.
- **Overlap visualisation**: when were *both* asleep — i.e. when the
  parents actually got a break. A metric the singleton app never had.
- Comparison stats (total sleep, nap count, longest stretch; divergence
  over time).
- Family handoff view: concise "siste 6 timar" timeline for an exhausted
  hand-off caregiver.
- `getFamilyState().family` powers these.

**Tests:** stats-view unit tests for multi-series + overlap math; visual
snapshots for the combined graph.

### Phase 4 — Twin scheduling intelligence (coupling, experimental)

**Goal (lateral big-win):** optionally help parents get the twins onto
overlapping sleep so *they* get simultaneous downtime — "maximise
overlapping parent sleep", a target the singleton engine never had.

**Hard guardrails (Codex):**
- **Opt-in, never default.** Predict-independently stays baseline.
- Suggest overlap only *inside each baby's acceptable window*.
- Prefer small start-time **nudges** over wake **caps**.
- Never let sync mode override illness/off-day, an overtired state, or a
  low-confidence prediction.
- Treat sync/cap actions as **parent policy, not natural evidence** (see
  principle 4) so the learner doesn't internalise the intervention.
- Worst case to avoid: forcing Twin B awake because Twin A is ready.
- A **what-if planner** ("legg Bo 12 min tidlegare for 42 min overlapp")
  is the safe UI for this — suggestion, parent decides.

Needs its own design pass + multi-day simulation tests before any code.
Largest engine change in the roadmap.

---

## Decisions still open

- babyId channel details + `getFamilyState` legacy-alias lifetime.
- Twin-vs-sibling detection: infer from age gap / ask once / toggle.
- Notification de-noising: merge same-kind non-urgent within 10–15 min
  ("Begge: snart lurtid"); never merge urgent nap-cap/rescue unless
  genuinely simultaneous; co-sleep "wake the other?" stays in-app, not a
  surprise push.
- How "simple" mixed-age / older-child mode is — does a 5yo need
  naps/strategy at all, or just bedtime + duration tracking?

## Codex design pass — done 2026-06-12

Read-only pass completed (no files changed). Verdict folded into this
doc. Headlines: (1) no hidden active-baby — family-first home (user then
ruled out a global switcher entirely, max 2 children); (2)
`getFamilyState` from `getBabyState`, engine
stays pure; (3) predictions independent by default, coupling is a bounded
opt-in overlay; (4) family-device subscriptions + baby-scoped dedupe +
named pushes; (5) the must-fix traps above (esp. `baby.updated` needs
event-level `babyId`). Codex review notes stay out of git per repo
convention; only decisions land here.
