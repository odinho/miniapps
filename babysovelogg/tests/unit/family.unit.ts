import { test, expect } from "bun:test";
import { isTwinMode, type FamilyModeOverride } from "../../src/lib/family.js";

const cases: Array<[string, string[], FamilyModeOverride, boolean]> = [
  ["same birthdate → twin", ["2025-06-12", "2025-06-12"], null, true],
  ["10 days apart → twin", ["2025-06-12", "2025-06-22"], null, true],
  ["exactly 21 days apart → twin", ["2025-06-01", "2025-06-22"], null, true],
  ["60 days apart → sibling", ["2025-06-12", "2025-08-12"], null, false],
  ["years apart → sibling", ["2020-01-01", "2025-06-12"], null, false],
  ["override twin beats a wide gap", ["2020-01-01", "2025-06-12"], "twin", true],
  ["override sibling beats a tiny gap", ["2025-06-12", "2025-06-12"], "sibling", false],
  ["single child is never twin-mode", ["2025-06-12"], null, false],
  ["single child ignores a twin override", ["2025-06-12"], "twin", false],
  ["no children", [], null, false],
];

test("isTwinMode: infer from age gap, override wins", () => {
  const rendered = cases.map(
    ([label, births, override, expected]) =>
      `${label}: ${isTwinMode(births, override)} (want ${expected})`,
  );
  expect(rendered).toMatchInlineSnapshot(`
    [
      "same birthdate → twin: true (want true)",
      "10 days apart → twin: true (want true)",
      "exactly 21 days apart → twin: true (want true)",
      "60 days apart → sibling: false (want false)",
      "years apart → sibling: false (want false)",
      "override twin beats a wide gap: true (want true)",
      "override sibling beats a tiny gap: false (want false)",
      "single child is never twin-mode: false (want false)",
      "single child ignores a twin override: false (want false)",
      "no children: false (want false)",
    ]
  `);

  for (const [label, births, override, expected] of cases) {
    expect(`${label}:${isTwinMode(births, override)}`).toBe(`${label}:${expected}`);
  }
});
