# Babysovelogg → SvelteKit Migration Plan

Mark things off in the list as you do them!

**Current status (2026-03-27):**
- Unit tests: 405 pass (17 files) — run with `bunx vitest run tests/unit/`
- Integration tests: 51 pass (9 files) — run with `bunx vitest run tests/integration/`
- E2E tests: 86 of 112 pass — run with `npx playwright test`
- Build: succeeds (`bun run build`)
- Typecheck: 10 errors (`bun run typecheck`)
- Lint: 13 errors (`bun run lint`)

**Remaining work:**
1. Fix typecheck errors (WakeUpPayload types, E2E `../types` imports)
2. Fix lint errors (unused imports, prefer-addEventListener)
3. Fix 26 failing E2E tests (see failure categories below)
4. Port CLI (`cli/baby.ts` + `tests/integration/cli.test.ts`) from main branch
5. Phase 6: Manual testing, UX review, adversarial branch review

Everything should work as it does on `main` branch, the CLI should be implemented and work. All
tests should work, all linting and typechecking should work.

## Context

The vanilla TypeScript UI (~5000+ lines of manual DOM manipulation) hasn't scaled well. The app needs a framework to make the UI maintainable. The backend event sourcing architecture and raw SQL are fine — the problem is the rendering layer, server boilerplate, and build tooling.

**Goal**: Replace the rendering/server/build layers with SvelteKit while keeping the core logic (engine, event sourcing, raw SQL) intact.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data model | Keep event sourcing | Works well, powers offline sync |
| Database | Raw SQL with `better-sqlite3` | SQL is simpler than query builders; no ORM. `bun:sqlite` incompatible with Vite SSR dev mode. |
| Backend | SvelteKit API routes only | 8 endpoints + SSE; no need for Hono |
| Offline | Keep offline writes | Queue mutations, replay on reconnect |
| Location | New branch (`sveltekit`) in same repo | Keep git history |

## Phases

### Phase 0: Scaffold — DONE

- [x] Create `sveltekit` branch
- [x] `bun create svelte` — Svelte 5, TypeScript, no extras
- [x] Configure `adapter-node`, `ssr: false`
- [x] Set up `better-sqlite3` in `src/lib/server/db.ts`
- [x] Copy engine files verbatim to `src/lib/engine/`
- [x] Copy server logic (events, projections, schemas, db) to `src/lib/server/`
- [x] Copy utility files (types, constants, identity, utils)
- [x] Verify: 91 unit tests pass against copied engine code

### Phase 1: API Routes — DONE

- [x] Port `server/api.ts` endpoints to `src/routes/api/*/+server.ts`
- [x] Port SSE broadcast to `src/routes/api/stream/+server.ts`
- [x] Port CSV import
- [x] Port export endpoint
- [x] Port admin/rebuild endpoint
- [x] Verify: API returns data from existing db.sqlite (tested via curl)
- [x] Port integration tests to new API shape (51 tests passing across 9 files)

### Phase 2: App Shell + Dashboard — DONE

- [x] Extract CSS from old `styles.ts` → `app.css`
- [x] Build `+layout.svelte` (nav bar, theme, SSE connection)
- [x] Build Svelte stores (`app.svelte.ts`, `sync.svelte.ts`)
- [x] Port `Arc.svelte` (SVG math as util `arc-utils.ts`, template for rendering)
- [x] Build `Timer.svelte` (live timer/countdown with auto-cleanup)
- [x] Build `SleepButton.svelte` (start/end sleep)
- [x] Build `TagSheet.svelte` (mood/method tagging)
- [x] Build `DiaperForm.svelte`
- [x] Build `WakeUpSheet.svelte` (morning prompt)
- [x] Build `+page.svelte` (dashboard) composing these components

### Phase 3: Secondary Views — DONE

- [x] `history/+page.svelte` + `EditSleepModal.svelte` + `EditDiaperModal.svelte`
- [x] `stats/+page.svelte` with bar charts
- [x] `settings/+page.svelte` with onboarding flow
- [x] `events/+page.svelte` (debug view)

### Phase 4: Offline + PWA — DONE

- [x] Port offline queue logic to `sync.svelte.ts` + `offline-queue.ts`
- [x] Service worker setup (`src/service-worker.ts`)
- [x] PWA manifest, icons (`static/manifest.json`, `static/icons/`)
- [ ] Test offline flow end-to-end (deferred to Phase 6 manual testing)

### Phase 5: Tests + Cutover — MOSTLY DONE

- [x] Port Playwright E2E tests (112 tests across 20 files, 86 passing)
- [x] Port integration tests to SvelteKit API (51 tests across 9 files)
- [x] Verify unit tests pass (405 tests across 17 files)
- [ ] Mobile viewport testing
- [x] Remove old files (already done on this branch)
- [ ] CLI needs to continue to work — **MISSING**: `cli/baby.ts` and `tests/integration/cli.test.ts`
  exist on `main` but were not ported to `sveltekit` branch

### Phase 6: Manual testing
- [ ] Fix *all* tests and checks (26 E2E failures, 10 typecheck errors, 13 lint errors)
- [ ] Do the three manual tests
- [ ] Check for UX issues and fix them while having done the manual testing
- [ ] Do a proper review of the entire branch

### E2E Failure Categories (26 tests)

| Category | Count | Tests |
|----------|-------|-------|
| Theme switching | 3 | theme.e2e.ts — CSS vars, data-theme, stars pseudo-elements |
| Undo toast | 2 | dashboard.e2e.ts:174, :192 — not implemented |
| Onboarding | 2 | onboarding.e2e.ts — Get Started button, validation |
| SSE/multi-client | 4 | sse.e2e.ts (2), multi-client.e2e.ts (2) |
| Wake-up/morning prompt | 2 | wakeup.e2e.ts:13, :65 |
| Tags/wake-up sheet | 5 | tags.e2e.ts:98, :117, :146, :175, :193 |
| Arc bubble | 2 | arc.e2e.ts:82 (click-to-edit), :151 (offline survive) |
| Diaper potty | 2 | diaper.e2e.ts:93, :119 — potty edit modal |
| Dashboard redirect | 1 | dashboard.e2e.ts:169 — no baby → settings |
| Bugs regressions | 2 | bugs.e2e.ts:46 (bedtime), :136 (morning button) |
| Settings sync badge | 1 | settings.e2e.ts:35 |

## Key Files for New Agents

- **Components**: `src/lib/components/*.svelte` (Arc, Timer, SleepButton, TagSheet, DiaperForm, WakeUpSheet, EditSleepModal, EditDiaperModal)
- **Stores**: `src/lib/stores/app.svelte.ts`, `src/lib/stores/sync.svelte.ts`
- **Pages**: `src/routes/+page.svelte`, `src/routes/{history,stats,settings,events}/+page.svelte`
- **API**: `src/routes/api/{events,state,sleeps,diapers,wakeups,stream,export}/+server.ts`, `src/routes/api/import/napper/+server.ts`, `src/routes/api/admin/rebuild/+server.ts`
- **Engine**: `src/lib/engine/{state,schedule,stats,classification,constants}.ts`
- **Server**: `src/lib/server/{db,events,projections,schemas,broadcast,state,import-napper}.ts`
- **Tests**: `tests/unit/*.unit.ts`, `tests/integration/*.test.ts`, `tests/*.e2e.ts`
- **E2E fixtures**: `tests/fixtures.ts`, `tests/helpers/render-state.ts`

## What Changed vs What Stayed

### Stays (copied/adapted)
- `src/lib/engine/*` — Pure logic (schedule, stats, classification, constants, state)
- `src/lib/server/events.ts` — Event store, dedup
- `src/lib/server/projections.ts` — Event handlers
- `src/lib/server/db.ts` — Schema init (better-sqlite3)
- `src/lib/server/schemas.ts` — Valibot validation
- `src/lib/server/import-napper.ts` — CSV import
- `src/lib/types.ts`, `constants.ts`, `identity.ts`, `utils.ts`

### Replaced
| Old | New | Why |
|-----|-----|-----|
| `server/index.ts` (bare HTTP) | SvelteKit `adapter-node` | Eliminates CORS, body parsing, static serving |
| `server/api.ts` (496 lines) | `src/routes/api/*/+server.ts` | SvelteKit handles routing/parsing |
| `src/main.ts` (hash routing) | SvelteKit file-based routing | Eliminates manual route matching |
| `src/ui/dashboard.ts` (1785 lines) | `+page.svelte` + components | Svelte eliminates DOM construction |
| `src/ui/arc.ts` (370 lines) | `Arc.svelte` | SVG math stays, DOM becomes template |
| `src/ui/history.ts` (826 lines) | `history/+page.svelte` + modals |
| `src/ui/stats.ts` (374 lines) | `stats/+page.svelte` |
| `src/ui/settings.ts` (442 lines) | `settings/+page.svelte` |
| `src/ui/styles.ts` (1114 lines CSS-in-JS) | `app.css` + scoped `<style>` |
| `esbuild.config.mjs` (83 lines) | Vite (built into SvelteKit) |

### Eliminated
- Manual `el()` DOM helpers, `innerHTML` cleanup patterns
- `setInterval` + cleanup array management (Svelte `$effect` auto-cleans)
- Hash-based route matching + route sequence counter
- Custom static file serving + MIME type map
- CSS injection via `<style>` element creation

## Expected Outcome

| Metric | Before | After |
|--------|--------|-------|
| UI code | ~5000 lines (manual DOM) | ~1500-2000 lines (Svelte components) |
| Server boilerplate | ~600 lines | ~0 (SvelteKit handles it) |
| Build config | 83 lines (esbuild) | ~10 lines (svelte.config.js) |
| CSS | 1114 lines in JS string | Same CSS, proper `.css` files |
| Engine + events + projections | ~1100 lines | ~1100 lines (unchanged) |
| **Total** | ~7500 lines | ~4000-4500 lines |

## Verification

1. ~~Run unit tests against copied engine code~~ — **405 tests passing**
2. ~~API returns real data from db.sqlite~~ — **verified via curl**
3. ~~Production build succeeds~~ — **client 70KB, server 350KB**
4. ~~Port integration tests to new API shape~~ — **51 tests passing**
5. ~~Port Playwright E2E tests to new UI~~ — **86 of 112 passing, 26 remaining**
6. "Manual" test (use chrome-devtools mcp): start sleep → end sleep → check history → check stats
7. "Manual" test (use chrome-devtools mcp): go offline → start sleep → reconnect → verify sync
8. "Manual" test (use chrome-devtools mcp): open on phone, check PWA install, check responsive layout
9. Adversarial review of the entire branch, find issues, find architectural things that can be
   improved, especially make sure the tests are great and cover what we need.
10. Go through UX and make sure it all makes good sense and feels like a really solid app, which is
    understandable to the wife.

--

Remember to update the file with any things the next agent should know. Or files it should read
early etc. So that the next agent can be more effective and need less time looking around the code
base.
