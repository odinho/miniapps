# babysovelogg

Baby sleep tracker. SvelteKit 5, better-sqlite3, Playwright + Vitest tests.

## Commands

- `bun run build` — build for production (required before E2E tests)
- `bun run dev` — SvelteKit dev server with HMR
- `bun run test:unit` — Vitest unit tests
- `bunx vitest run tests/integration/` — Vitest integration tests
- `bun run test:e2e` — Playwright E2E tests (needs fresh build)
- `bun run lint` — oxlint
- `bun run typecheck` — svelte-check

## Test naming

- `.unit.ts` — unit tests (Vitest)
- `.test.ts` — integration tests (Vitest)
- `.e2e.ts` — E2E tests (Playwright)
- Never use `.spec.ts`

## Language

UI text is in Nynorsk Norwegian. Keep it consistent.
