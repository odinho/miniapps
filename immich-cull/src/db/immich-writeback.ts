/**
 * Immich API write-back: soft-delete (trash) culled photos, set star ratings.
 *
 * All deletions go to Immich trash (30-day recovery) — never permanent.
 * Star ratings use the LLM's 0-5 scale mapped to Immich's 0-5 rating.
 *
 * Requires:
 *   - Immich server URL (e.g., http://192.168.10.74:2283)
 *   - API key (from Immich admin panel → API Keys)
 */

export interface ImmichWritebackConfig {
  serverUrl: string;
  apiKey: string;
}

export class ImmichWriteback {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ImmichWritebackConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, "");
    this.headers = {
      "x-api-key": config.apiKey,
      "Content-Type": "application/json",
    };
  }

  /** Move assets to Immich trash (30-day recovery). Never permanently deletes. */
  async trashAssets(assetIds: string[]): Promise<{ success: number; failed: number }> {
    if (assetIds.length === 0) return { success: 0, failed: 0 };

    // Immich bulk delete endpoint — force=false means trash, not permanent
    const resp = await fetch(`${this.baseUrl}/api/assets`, {
      method: "DELETE",
      headers: this.headers,
      body: JSON.stringify({ ids: assetIds, force: false }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Immich trash failed (${resp.status}): ${text}`);
    }

    // Immich returns 204 No Content on success
    return { success: assetIds.length, failed: 0 };
  }

  /** Set star rating on a single asset (0-5). */
  async setRating(assetId: string, rating: number): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/api/assets/${assetId}`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ rating: Math.max(0, Math.min(5, Math.round(rating))) }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Immich set rating failed (${resp.status}): ${text}`);
    }
  }

  /** Bulk set star ratings (all concurrent). */
  async setRatings(
    ratings: Array<{ assetId: string; rating: number }>,
  ): Promise<{ success: number; failed: number }> {
    const results = await Promise.allSettled(
      ratings.map(({ assetId, rating }) => this.setRating(assetId, rating)),
    );
    const success = results.filter((r) => r.status === "fulfilled").length;
    return { success, failed: results.length - success };
  }

  /** Test connection to Immich API. */
  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/server/version`, {
        headers: { "x-api-key": this.headers["x-api-key"] },
      });
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { major: number; minor: number; patch: number };
      return { ok: true, version: `${data.major}.${data.minor}.${data.patch}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
