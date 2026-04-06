/**
 * Read-only adapter for Immich's PostgreSQL database.
 * Connects via SSH tunnel or direct connection.
 * Reads assets, CLIP embeddings, and ratings.
 *
 * IMPORTANT: This adapter is READ-ONLY. All writes go through the Immich API.
 * The smart_search table schema is internal to Immich and may change between versions.
 * Tested with Immich v2.5.2.
 */
import pg from "pg";
import { Asset } from "../shared/types.js";

export interface ImmichDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class ImmichAdapter {
  private pool: pg.Pool;

  constructor(config: ImmichDbConfig) {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 5,
      // Read-only safety
      application_name: "immich-cull-readonly",
    });
  }

  /** Count images with CLIP embeddings */
  async getAssetCount(): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(*) as cnt
      FROM asset a
      JOIN smart_search s ON a.id = s."assetId"
      WHERE a.type = 'IMAGE' AND a."deletedAt" IS NULL
    `);
    return parseInt(result.rows[0].cnt);
  }

  /**
   * Load all image assets with embeddings in batches.
   * Embeddings are returned as pgvector text format and parsed to Float32Array.
   */
  async getAllAssets(onProgress?: (loaded: number, total: number) => void): Promise<Asset[]> {
    const total = await this.getAssetCount();
    const batchSize = 5000;
    const assets: Asset[] = [];

    let offset = 0;
    while (offset < total) {
      const result = await this.pool.query(
        `
        SELECT a.id, a."originalFileName", a."originalPath",
               a."fileCreatedAt", a."duplicateId", a."isFavorite",
               e.rating,
               s.embedding::text as embedding_text
        FROM asset a
        JOIN smart_search s ON a.id = s."assetId"
        LEFT JOIN asset_exif e ON a.id = e."assetId"
        WHERE a.type = 'IMAGE' AND a."deletedAt" IS NULL
        ORDER BY a."fileCreatedAt" ASC
        LIMIT $1 OFFSET $2
        `,
        [batchSize, offset]
      );

      for (const row of result.rows) {
        const embedding = parseEmbedding(row.embedding_text);
        if (!embedding) continue;

        assets.push({
          id: row.id,
          path: row.originalPath,
          filename: row.originalFileName,
          fileCreatedAt: new Date(row.fileCreatedAt),
          embedding,
          rating: row.rating != null ? row.rating : null,
          isFavorite: row.isFavorite,
          duplicateId: row.duplicateId,
        });
      }

      offset += batchSize;
      onProgress?.(Math.min(offset, total), total);
    }

    return assets;
  }

  /** Get a sample of assets for quick testing */
  async getSampleAssets(limit: number = 1000): Promise<Asset[]> {
    const result = await this.pool.query(
      `
      SELECT a.id, a."originalFileName", a."originalPath",
             a."fileCreatedAt", a."duplicateId", a."isFavorite",
             e.rating,
             s.embedding::text as embedding_text
      FROM asset a
      JOIN smart_search s ON a.id = s."assetId"
      LEFT JOIN asset_exif e ON a.id = e."assetId"
      WHERE a.type = 'IMAGE' AND a."deletedAt" IS NULL
      ORDER BY a."fileCreatedAt" DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows
      .map((row) => {
        const embedding = parseEmbedding(row.embedding_text);
        if (!embedding) return null;
        return {
          id: row.id,
          path: row.originalPath,
          filename: row.originalFileName,
          fileCreatedAt: new Date(row.fileCreatedAt),
          embedding,
          rating: row.rating != null ? row.rating : null,
          isFavorite: row.isFavorite,
          duplicateId: row.duplicateId,
        } satisfies Asset;
      })
      .filter((a): a is Asset => a !== null);
  }

  /** Get rating distribution for stats */
  async getRatingDistribution(): Promise<Map<number | null, number>> {
    const result = await this.pool.query(`
      SELECT e.rating, COUNT(*) as cnt
      FROM asset a
      JOIN asset_exif e ON a.id = e."assetId"
      WHERE a.type = 'IMAGE' AND a."deletedAt" IS NULL
      GROUP BY e.rating ORDER BY e.rating
    `);
    const dist = new Map<number | null, number>();
    for (const row of result.rows) {
      dist.set(row.rating, parseInt(row.cnt));
    }
    return dist;
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Parse pgvector text representation "[0.1,0.2,...]" to Float32Array.
 */
function parseEmbedding(text: string): Float32Array | null {
  if (!text) return null;
  try {
    const stripped = text.replace(/^\[/, "").replace(/\]$/, "");
    const values = stripped.split(",").map(Number);
    return new Float32Array(values);
  } catch {
    return null;
  }
}
