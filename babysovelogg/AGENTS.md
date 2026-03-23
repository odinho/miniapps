# babysovelogg

Baby sleep tracker. Vanilla TypeScript, esbuild, SQLite backend.

## Commands

- `pnpm check` — typecheck + lint + format check (run before committing)
- `pnpm build` — bundle client + server to dist/ (required before e2e tests)
- `pnpm test` — playwright e2e tests (builds must be fresh: clean old bundles first)
- `pnpm test:unit` — vitest unit tests
- `pnpm dev` — watch mode for development

## Build gotcha

esbuild uses content-hashed filenames. Old bundles linger in dist/. Before testing, clean stale bundles:

```sh
rm -f dist/bundle-*.js dist/bundle-*.js.map && pnpm build
```

## Test naming

- `.unit.ts` — unit tests (vitest)
- `.test.ts` — integration tests (playwright)
- `.e2e.ts` — e2e tests (playwright)
- Never use `.spec.ts`

## Language

UI text is in Nynorsk Norwegian. Keep it consistent.
