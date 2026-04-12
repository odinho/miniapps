/**
 * Immich API adapter: fetch assets and thumbnails via the REST API.
 *
 * Unlike the PostgreSQL adapter, this doesn't require SSH tunnels
 * or direct DB access. Works over the network via Immich's API.
 *
 * Trade-off: no CLIP embeddings (clustering is time-based only),
 * but simpler setup and the LLM handles similarity grouping itself.
 *
 * Requires IMMICH_URL and IMMICH_API_KEY environment variables.
 */

import { Asset } from "../shared/types.js";

export interface ImmichApiConfig {
  serverUrl: string;
  apiKey: string;
}

export class ImmichApiAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ImmichApiConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, "");
    this.headers = { "x-api-key": config.apiKey, Accept: "application/json" };
  }

  /** Get total asset count. */
  async getAssetCount(): Promise<number> {
    const resp = await fetch(`${this.baseUrl}/api/server/statistics`, { headers: this.headers });
    if (!resp.ok) throw new Error(`Immich API error: ${resp.status}`);
    const data = (await resp.json()) as { photos: number; videos: number; usage: number };
    return data.photos;
  }

  /** Fetch all image assets with metadata. No CLIP embeddings — returns empty Float32Array. */
  async getAllAssets(onProgress?: (loaded: number) => void): Promise<Asset[]> {
    return this.searchAssets({ type: "IMAGE" }, onProgress);
  }

  /** Get thumbnail JPEG buffer for an asset. */
  async getThumbnail(assetId: string, size: "preview" | "thumbnail" = "preview"): Promise<Buffer> {
    const resp = await fetch(`${this.baseUrl}/api/assets/${assetId}/thumbnail?size=${size}`, {
      headers: { "x-api-key": this.headers["x-api-key"] },
    });
    if (!resp.ok) throw new Error(`Immich thumbnail error: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Get original file buffer for an asset. */
  async getOriginal(assetId: string): Promise<Buffer> {
    const resp = await fetch(`${this.baseUrl}/api/assets/${assetId}/original`, {
      headers: { "x-api-key": this.headers["x-api-key"] },
    });
    if (!resp.ok) throw new Error(`Immich original error: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Search assets by date range. */
  async getAssetsByDateRange(
    start: Date,
    end: Date,
    onProgress?: (loaded: number) => void,
  ): Promise<Asset[]> {
    return this.searchAssets(
      { type: "IMAGE", takenAfter: start.toISOString(), takenBefore: end.toISOString() },
      onProgress,
    );
  }

  /** Internal: paginated search via POST /api/search/metadata. */
  private async searchAssets(
    query: Record<string, unknown>,
    onProgress?: (loaded: number) => void,
  ): Promise<Asset[]> {
    const assets: Asset[] = [];
    const fetchPage = async (page: number): Promise<{ items: any[]; nextPage: string | null }> => {
      const resp = await fetch(`${this.baseUrl}/api/search/metadata`, {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...query, page, size: 1000 }),
      });
      if (!resp.ok) throw new Error(`Immich search error: ${resp.status}`);
      const data = (await resp.json()) as any;
      return { items: data.assets?.items ?? [], nextPage: data.assets?.nextPage ?? null };
    };

    const processPage = async (page: number): Promise<Asset[]> => {
      const { items, nextPage } = await fetchPage(page);
      for (const item of items) {
        assets.push({
          id: item.id,
          path: item.originalPath ?? "",
          filename: item.originalFileName ?? "",
          fileCreatedAt: new Date(item.fileCreatedAt ?? item.createdAt),
          embedding: new Float32Array(0),
          rating: item.rating ?? 0,
          isFavorite: item.isFavorite ?? false,
          duplicateId: item.duplicateId ?? null,
        });
      }
      onProgress?.(assets.length);
      if (nextPage) return processPage(Number(nextPage));
      return assets;
    };

    return processPage(1);
  }
}
