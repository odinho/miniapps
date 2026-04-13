import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("preserves input order in results", async () => {
    const items = [30, 10, 20, 5, 15];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      await wait(n);
      return n * 2;
    });
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([60, 20, 40, 10, 30]);
  });

  it("continues running siblings when one rejects", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n * 10;
    });
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: false, error: expect.any(Error) });
    expect(results[2]).toEqual({ ok: true, value: 30 });
    expect(results[3]).toEqual({ ok: true, value: 40 });
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await wait(10);
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3); // should actually reach the limit
  });

  it("handles empty input", async () => {
    const results = await mapWithConcurrency([], 5, async () => 42);
    expect(results).toEqual([]);
  });

  it("handles limit larger than item count", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n);
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([1, 2]);
  });

  it("throws when limit is less than 1", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow("limit must be >= 1");
  });

  it("passes index to the fn", async () => {
    const results = await mapWithConcurrency(
      ["a", "b", "c"],
      2,
      async (item, idx) => `${idx}:${item}`,
    );
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual(["0:a", "1:b", "2:c"]);
  });
});
