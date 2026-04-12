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
    const resp = await fetch(`${this.baseUrl}/api/assets/statistics`, { headers: this.headers });
    if (!resp.ok) throw new Error(`Immich API error: ${resp.status}`);
    const data = (await resp.json()) as { images: number; videos: number; total: number };
    return data.images;
  }

  /** Fetch all image assets with metadata. No CLIP embeddings — returns empty Float32Array. */
  async getAllAssets(onProgress?: (loaded: number) => void): Promise<Asset[]> {
    return this.fetchPaginated(
      `${this.baseUrl}/api/assets?order=desc&isVisible=true&type=IMAGE`,
      onProgress,
    );
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
    const startStr = start.toISOString();
    const endStr = end.toISOString();
    return this.fetchPaginated(
      `${this.baseUrl}/api/assets?takenAfter=${startStr}&takenBefore=${endStr}&order=asc&isVisible=true&type=IMAGE`,
      onProgress,
    );
  }

  /** Internal: paginated fetch with asset parsing. */
  private async fetchPaginated(
    baseUrl: string,
    onProgress?: (loaded: number) => void,
  ): Promise<Asset[]> {
    const assets: Asset[] = [];
    const fetchPage = async (page: number): Promise<any[]> => {
      const sep = baseUrl.includes("?") ? "&" : "?";
      const resp = await fetch(`${baseUrl}${sep}page=${page}&size=1000`, {
        headers: this.headers,
      });
      if (!resp.ok) throw new Error(`Immich API error: ${resp.status}`);
      return (await resp.json()) as any[];
    };

    const processPage = async (page: number): Promise<Asset[]> => {
      const items = await fetchPage(page);
      const parsed: Asset[] = items.map((item: any) => ({
        id: item.id,
        path: item.originalPath ?? "",
        filename: item.originalFileName ?? "",
        fileCreatedAt: new Date(item.fileCreatedAt ?? item.createdAt),
        embedding: new Float32Array(0),
        rating: item.rating ?? 0,
        isFavorite: item.isFavorite ?? false,
        duplicateId: item.duplicateId ?? null,
      }));
      assets.push(...parsed);
      onProgress?.(assets.length);
      if (items.length >= 1000) return processPage(page + 1);
      return assets;
    };

    return processPage(1);
  }
}
