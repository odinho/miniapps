import { test, expect } from "bun:test";
import { shouldApplyRevision } from "../../src/lib/revision.js";

test("shouldApplyRevision: drops a strictly-older revision, applies same-or-newer", () => {
  const cases: Array<[string, number | undefined, number, boolean]> = [
    ["newer applies", 7, 5, true],
    ["same applies (idempotent re-fetch / optimistic at base)", 5, 5, true],
    ["strictly-older drops (the stale-response race)", 3, 5, false],
    ["no revision info → always apply (per-baby slice / empty state)", undefined, 5, true],
    ["revision 0 → always apply", 0, 5, true],
    ["first apply against initial 0", 1, 0, true],
  ];

  const rendered = cases.map(
    ([label, inc, applied, want]) =>
      `${label}: ${shouldApplyRevision(inc, applied)} (want ${want})`,
  );
  expect(rendered).toMatchInlineSnapshot(`
    [
      "newer applies: true (want true)",
      "same applies (idempotent re-fetch / optimistic at base): true (want true)",
      "strictly-older drops (the stale-response race): false (want false)",
      "no revision info → always apply (per-baby slice / empty state): true (want true)",
      "revision 0 → always apply: true (want true)",
      "first apply against initial 0: true (want true)",
    ]
  `);

  for (const [, inc, applied, want] of cases) {
    expect(shouldApplyRevision(inc, applied)).toBe(want);
  }
});
