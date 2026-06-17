/** Assert that two ISO timestamps are within `withinMin` minutes of each other. */
export function expectTimeNear(actualISO: string, expectedISO: string, withinMin = 5): void {
  const actual = new Date(actualISO).getTime();
  const expected = new Date(expectedISO).getTime();
  if (Number.isNaN(actual)) throw new Error(`expectTimeNear: actual is not a valid time: ${actualISO}`);
  if (Number.isNaN(expected)) throw new Error(`expectTimeNear: expected is not a valid time: ${expectedISO}`);
  const diffMin = Math.abs(actual - expected) / 60_000;
  if (diffMin > withinMin) {
    throw new Error(
      `expectTimeNear: ${actualISO} is ${diffMin.toFixed(1)} min from ${expectedISO} (tolerance ${withinMin} min)`,
    );
  }
}
