/**
 * Bounded concurrency helper: run `fn` over `items` with at most `limit`
 * in-flight at a time. Results are returned in input order. Individual
 * failures do not cancel siblings — each item gets a settled result.
 */

export type SettledResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>[]> {
  if (limit < 1) throw new Error("limit must be >= 1");
  const results: SettledResult<R>[] = Array.from({ length: items.length });
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try {
        // eslint-disable-next-line no-await-in-loop -- intentional: workers await sequentially, concurrency comes from running N workers in parallel
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
