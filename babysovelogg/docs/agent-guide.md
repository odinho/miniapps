# Agent Guide

Use this only when the change crosses layers or you need a fast repo map.

Read first if the task touches events, projections, API shape, optimistic sync, or prediction logic.

For workflow (Codex pair-review, followups.md as durable todo,
multi-day testing, unit-of-work flow): see [`workflow.md`](./workflow.md).

## Authoritative Files

### App structure

- [`src/routes/+page.svelte`](../src/routes/+page.svelte) — dashboard
- [`src/routes/history/+page.svelte`](../src/routes/history/+page.svelte) — history
- [`src/routes/stats/+page.svelte`](../src/routes/stats/+page.svelte) — stats
- [`src/routes/settings/+page.svelte`](../src/routes/settings/+page.svelte) — settings

### Event-sourced backend

- [`src/lib/server/db.ts`](../src/lib/server/db.ts) — schema and DB init
- [`src/lib/server/events.ts`](../src/lib/server/events.ts) — event append path
- [`src/lib/server/projections.ts`](../src/lib/server/projections.ts) — event to materialized tables
- [`src/lib/server/state.ts`](../src/lib/server/state.ts) — assembled server state
- [`src/lib/server/schemas.ts`](../src/lib/server/schemas.ts) — event payload validation

### Prediction and pure logic

- [`src/lib/engine/schedule.ts`](../src/lib/engine/schedule.ts) — nap and bedtime prediction
- [`src/lib/engine/state.ts`](../src/lib/engine/state.ts) — derived app state assembly
- [`src/lib/engine/stats.ts`](../src/lib/engine/stats.ts) — stats logic
- [`src/lib/engine/classification.ts`](../src/lib/engine/classification.ts) — nap/night classification

### Notifications (Web Push)

- [`src/lib/server/webpush.ts`](../src/lib/server/webpush.ts) — VAPID config, send helpers
- [`src/lib/server/notification-scheduler.ts`](../src/lib/server/notification-scheduler.ts) — trigger logic + fire loop
- [`src/lib/server/notification-prefs.ts`](../src/lib/server/notification-prefs.ts) — per-trigger opt-in prefs
- [`src/lib/notifications.ts`](../src/lib/notifications.ts) — client subscribe/unsubscribe, trigger labels
- [`src/service-worker/index.ts`](../src/service-worker/index.ts) — push event handler
- [`src/hooks.server.ts`](../src/hooks.server.ts) — starts notification loop on boot
- See [`docs/archive/notifications-implementation.md`](archive/notifications-implementation.md) for architecture and trigger details

### Client state and sync

- [`src/lib/stores/app.svelte.ts`](../src/lib/stores/app.svelte.ts) — main app state
- [`src/lib/stores/sync.svelte.ts`](../src/lib/stores/sync.svelte.ts) — SSE and sync flow
- [`src/lib/offline-queue.ts`](../src/lib/offline-queue.ts) — optimistic offline updates

### Tests and harnesses

- [`tests/fixtures.ts`](../tests/fixtures.ts) — shared DB + Playwright harness
- [`tests/integration/harness.ts`](../tests/integration/harness.ts) — HTTP integration harness
- [`tests/helpers/render-state.ts`](../tests/helpers/render-state.ts) — full-state renderer helpers

## Common Change Paths

### New event type or changed event payload

Touch these in order:

1. [`src/lib/server/schemas.ts`](../src/lib/server/schemas.ts)
2. [`src/lib/server/events.ts`](../src/lib/server/events.ts) if append semantics change
3. [`src/lib/server/projections.ts`](../src/lib/server/projections.ts)
4. [`src/lib/server/state.ts`](../src/lib/server/state.ts) if returned state changes
5. [`src/lib/offline-queue.ts`](../src/lib/offline-queue.ts) if optimistic behavior must match
6. tests in [`tests/integration/`](../tests/integration/)
7. E2E only if the user-visible browser flow is the point

### Database schema or projection change

Check:

1. [`src/lib/server/db.ts`](../src/lib/server/db.ts)
2. [`src/lib/server/projections.ts`](../src/lib/server/projections.ts)
3. [`src/routes/api/admin/rebuild/+server.ts`](../src/routes/api/admin/rebuild/+server.ts) if rebuild assumptions change
4. rebuild and export tests in [`tests/integration/`](../tests/integration/)

### UI feature or text change

Check:

1. route file in [`src/routes/`](../src/routes/)
2. reusable components in [`src/lib/components/`](../src/lib/components/)
3. state actions or helpers in [`src/lib/`](../src/lib/)
4. keep visible strings in Nynorsk

### Prediction or sleep-logic change

Check:

1. [`src/lib/engine/schedule.ts`](../src/lib/engine/schedule.ts) — start with the function that owns the behavior (`predictNapEndTime`, `getLearnedNapDuration`, `predictDayNaps`, etc.)
2. [`src/lib/engine/constants.ts`](../src/lib/engine/constants.ts) and [`src/lib/data/`](../src/lib/data/) — age priors are SHINE 2021 / Galland 2012 derived; if you find yourself adding hardcoded age ladders, check these first
3. fixtures in [`tests/fixtures/`](../tests/fixtures/)
4. unit tests in [`tests/unit/`](../tests/unit/) — `learned-duration-scenarios.unit.ts` is the table-style behavior log; `schedule.unit.ts` and `duration-prediction.unit.ts` cover the rest
5. when learned-data semantics change, also check `getPositionalNapDurations`, `estimateSleepCycleFromData`, and `confidence.ts` — anything that consumes nap durations should respect the same data-quality filters (e.g. `censorCutShortNaps`)
6. integration or E2E coverage if user-visible behavior changes

### API endpoint change

Check:

1. route in [`src/routes/api/`](../src/routes/api/)
2. server state and projection dependencies
3. integration tests first

### New notification trigger

Touch these in order:

1. Add kind to [`src/lib/server/notification-prefs.ts`](../src/lib/server/notification-prefs.ts) (`NotificationKind`, `DEFAULT_PREFS`, `ALL_KINDS`)
2. Add trigger logic in [`src/lib/server/notification-scheduler.ts`](../src/lib/server/notification-scheduler.ts) `reconcileNotifications()`
3. Add Nynorsk label/hint in [`src/lib/notifications.ts`](../src/lib/notifications.ts) `TRIGGER_LABELS`
4. Unit tests in [`tests/unit/notification-scheduler.unit.ts`](../tests/unit/notification-scheduler.unit.ts)
5. If new tables: update [`src/lib/server/projections.ts`](../src/lib/server/projections.ts) rebuild cleanup

## Easy Mistakes To Avoid

- Updating projections but not optimistic client state
- Changing visible UI text away from Nynorsk
- Using E2E tests for behavior that should be integration-tested
- Forgetting that E2E runs against a built server, not the dev server
- Treating local working data folders as app source of truth
