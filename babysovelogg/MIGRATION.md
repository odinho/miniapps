# Babysovelogg → SvelteKit Migration Plan

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
- [ ] Port integration tests to new API shape (deferred — old tests used `handleRequest`)

### Phase 2: App Shell + Dashboard

- [ ] Extract CSS from old `styles.ts` → `app.css`
- [ ] Build `+layout.svelte` (nav bar, theme, SSE connection)
- [ ] Build Svelte stores (`app.svelte.ts`, `sync.svelte.ts`)
- [ ] Port `Arc.svelte` (SVG math as util, template for rendering)
- [ ] Build `Timer.svelte` (live timer/countdown with auto-cleanup)
- [ ] Build `SleepButton.svelte` (start/end sleep)
- [ ] Build `TagSheet.svelte` (mood/method tagging)
- [ ] Build `DiaperForm.svelte`
- [ ] Build `WakeUpSheet.svelte` (morning prompt)
- [ ] Build `+page.svelte` (dashboard) composing these components

### Phase 3: Secondary Views

- [ ] `history/+page.svelte` + `EditSleepModal.svelte` + `EditDiaperModal.svelte`
- [ ] `stats/+page.svelte` with bar charts
- [ ] `settings/+page.svelte` with onboarding flow
- [ ] `events/+page.svelte` (debug view)

### Phase 4: Offline + PWA

- [ ] Port offline queue logic to `sync.svelte.ts`
- [ ] Service worker setup
- [ ] PWA manifest, icons
- [ ] Test offline flow end-to-end

### Phase 5: Tests + Cutover

- [ ] Port Playwright E2E tests (routes change from `#/history` to `/history`)
- [ ] Port integration tests to SvelteKit API
- [ ] Verify unit tests pass
- [ ] Mobile viewport testing
- [ ] Remove old files (already done on this branch)

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

1. ~~Run unit tests against copied engine code~~ — **91 tests passing**
2. ~~API returns real data from db.sqlite~~ — **verified via curl**
3. ~~Production build succeeds~~ — **client 70KB, server 350KB**
4. Port integration tests to new API shape
5. Port Playwright E2E tests to new UI
6. Manual test: start sleep → end sleep → check history → check stats
7. Manual test: go offline → start sleep → reconnect → verify sync
8. Manual test: open on phone, check PWA install, check responsive layout
