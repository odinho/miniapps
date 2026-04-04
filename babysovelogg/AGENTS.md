# babysovelogg

Baby sleep tracker. SvelteKit 5, better-sqlite3, Playwright + bun:test.

## Commands

- `bun run build` — build for production (required before E2E tests)
- `bun run dev` — SvelteKit dev server with HMR
- `bun run test:unit` — bun:test unit tests
- `bun run test:integration` — bun:test integration tests
- `bun run test:e2e` — Playwright E2E tests (needs fresh build)
- `bun run lint` — oxlint
- `bun run typecheck` — svelte-check

## Testing

Read [`docs/testing.md`](docs/testing.md) before writing or updating tests.

## Language

UI text is in Nynorsk Norwegian. Keep it consistent.

## Local Working Data

Put untracked datasets, exports, and scratch files under `local/` instead of at repo root.

## Fast Context

For cross-cutting changes, read [`docs/agent-guide.md`](docs/agent-guide.md) for the repo map and common change paths.
