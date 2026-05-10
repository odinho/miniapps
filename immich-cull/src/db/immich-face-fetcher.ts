/**
 * Fetches Immich-recognised NAMED people per asset, with an in-memory cache.
 *
 * Only returns named people. Unnamed face clusters are dropped — they caused
 * 4 of 6 regressions in the all-cluster face-coverage experiment because the
 * same person was often split into named + unnamed clusters, causing
 * near-duplicate promotions.
 */

export class ImmichFaceFetcher {
  private cache = new Map<string, readonly string[]>();
  private inFlight = new Map<string, Promise<readonly string[]>>();

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Fetch named people for every asset, cached. Concurrent calls for the same
   * asset coalesce. Failures return an empty list (we'd rather skip
   * face-coverage for an asset than block the auto-cull pipeline).
   */
  async fetchPeopleForAssets(assetIds: readonly string[]): Promise<Map<string, readonly string[]>> {
    const result = new Map<string, readonly string[]>();
    const pending: Array<Promise<void>> = [];

    for (const id of assetIds) {
      const cached = this.cache.get(id);
      if (cached !== undefined) {
        result.set(id, cached);
        continue;
      }
      let existing = this.inFlight.get(id);
      if (existing === undefined) {
        existing = this.fetchOne(id);
        this.inFlight.set(id, existing);
      }
      pending.push(
        existing.then((people) => {
          result.set(id, people);
          this.cache.set(id, people);
          this.inFlight.delete(id);
        }),
      );
    }

    await Promise.all(pending);
    return result;
  }

  private async fetchOne(assetId: string): Promise<readonly string[]> {
    try {
      const r = await fetch(`${this.serverUrl.replace(/\/$/, "")}/api/assets/${assetId}`, {
        headers: { "x-api-key": this.apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { people?: Array<{ name?: string }> };
      return (j.people ?? []).filter((p) => p.name?.trim()).map((p) => `name:${p.name!.trim()}`);
    } catch {
      return [];
    }
  }
}
