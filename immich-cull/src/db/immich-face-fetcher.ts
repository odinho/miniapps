/**
 * Fetches Immich-recognised NAMED people per asset.
 *
 * Only returns named people. Unnamed face clusters are dropped — they caused
 * 4 of 6 regressions in the all-cluster face-coverage experiment because the
 * same person was often split into named + unnamed clusters, causing
 * near-duplicate promotions.
 *
 * Builds an asset → people index once per process by listing named people and
 * searching each one's assets. The old per-asset GET /api/assets/:id approach
 * meant ~70k requests on the first /api/batches call (every ranked batch is
 * summarised in parallel), which flooded Immich and took 20+ minutes remotely.
 */

import { mapWithConcurrency } from "../cli/concurrency.js";

interface PeoplePage {
  people: Array<{ id: string; name: string }>;
  hasNextPage?: boolean;
}

interface SearchPage {
  assets?: { items?: Array<{ id: string }>; nextPage?: string | null };
}

export class ImmichFaceFetcher {
  private index: Promise<Map<string, readonly string[]>> | null = null;

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly maxConcurrent = 8,
  ) {}

  /**
   * Named people for every asset. If the index can't be built we return empty
   * lists (we'd rather skip face-coverage than block the auto-cull pipeline)
   * and retry the build on the next call.
   */
  async fetchPeopleForAssets(assetIds: readonly string[]): Promise<Map<string, readonly string[]>> {
    this.index ??= this.buildIndex();
    let index: Map<string, readonly string[]>;
    try {
      index = await this.index;
    } catch (err) {
      this.index = null;
      console.warn("face index build failed:", err);
      index = new Map();
    }
    return new Map(assetIds.map((id) => [id, index.get(id) ?? []]));
  }

  private async buildIndex(): Promise<Map<string, readonly string[]>> {
    const started = Date.now();
    const named: Array<{ id: string; name: string }> = [];
    for (let page = 1; ; page++) {
      // eslint-disable-next-line no-await-in-loop -- pagination is sequential
      const data = await this.request<PeoplePage>(
        `/api/people?size=1000&page=${page}&withHidden=true`,
      );
      for (const p of data.people) {
        const name = p.name.trim();
        if (name) named.push({ id: p.id, name });
      }
      if (!data.hasNextPage) break;
    }

    const results = await mapWithConcurrency(named, this.maxConcurrent, (p) =>
      this.assetIdsForPerson(p.id),
    );

    const index = new Map<string, string[]>();
    for (const [i, r] of results.entries()) {
      if (!r.ok) throw r.error;
      const label = `name:${named[i].name}`;
      for (const assetId of r.value) {
        const list = index.get(assetId);
        if (!list) index.set(assetId, [label]);
        else if (!list.includes(label)) list.push(label);
      }
    }
    console.log(
      `Face index: ${named.length} named people, ${index.size} assets (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    return index;
  }

  private async assetIdsForPerson(personId: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page: number | null = 1; page !== null; ) {
      // eslint-disable-next-line no-await-in-loop -- pagination is sequential
      const data: SearchPage = await this.request<SearchPage>("/api/search/metadata", {
        personIds: [personId],
        page,
        size: 1000,
      });
      for (const a of data.assets?.items ?? []) ids.push(a.id);
      page = data.assets?.nextPage ? Number(data.assets.nextPage) : null;
    }
    return ids;
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.serverUrl.replace(/\/$/, "")}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`Immich ${path}: ${r.status}`);
    return (await r.json()) as T;
  }
}
