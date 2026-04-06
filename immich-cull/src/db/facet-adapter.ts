/**
 * Read-only adapter for Facet's SQLite database.
 * Used for local testing without Immich.
 * Facet stores CLIP ViT-L-14 embeddings (768-dim, 3072 bytes as float32).
 */
import Database from "better-sqlite3";
import { Asset } from "../shared/types.js";

export class FacetAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
  }

  getAllAssets(): Asset[] {
    const rows = this.db
      .prepare(
        `SELECT path, filename, date_taken, clip_embedding, star_rating, is_favorite, burst_group_id
         FROM photos
         WHERE clip_embedding IS NOT NULL
         ORDER BY date_taken ASC`
      )
      .all() as Array<{
      path: string;
      filename: string;
      date_taken: string | null;
      clip_embedding: Buffer;
      star_rating: number | null;
      is_favorite: number | null;
      burst_group_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.path,
      path: row.path,
      filename: row.filename,
      fileCreatedAt: parseFacetDate(row.date_taken),
      embedding: new Float32Array(
        row.clip_embedding.buffer,
        row.clip_embedding.byteOffset,
        row.clip_embedding.byteLength / 4
      ),
      rating: row.star_rating,
      isFavorite: row.is_favorite === 1,
      duplicateId: row.burst_group_id,
    }));
  }

  getAssetCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM photos WHERE clip_embedding IS NOT NULL")
      .get() as { cnt: number };
    return row.cnt;
  }

  close() {
    this.db.close();
  }
}

function parseFacetDate(dateStr: string | null): Date {
  if (!dateStr) return new Date(0);
  // Facet format: "2025:02:20 08:00:27"
  const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  return new Date(normalized);
}
