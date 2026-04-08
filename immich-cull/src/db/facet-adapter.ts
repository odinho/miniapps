/**
 * Read-only adapter for Facet's SQLite database.
 * Used for local testing without Immich.
 * Facet stores CLIP ViT-L-14 embeddings (768-dim, 3072 bytes as float32).
 */
import Database from "better-sqlite3";
import { Asset } from "../shared/types.js";
import { tryParseFilenameDate } from "../shared/filename-dates.js";

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
         ORDER BY date_taken ASC`,
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

    return rows.map((row) => {
      let date = parseFacetDate(row.date_taken);
      // Fallback: try parsing timestamp from filename (e.g. Snapchat-{unix}.jpg)
      if (date.getTime() === 0) {
        date = tryParseFilenameDate(row.filename) ?? date;
      }

      return {
        id: row.path,
        path: row.path,
        filename: row.filename,
        fileCreatedAt: date,
        // Safe copy into aligned ArrayBuffer (Buffer offset may not be 4-byte aligned)
        embedding: copyToFloat32Array(row.clip_embedding),
        rating: row.star_rating,
        isFavorite: row.is_favorite === 1,
        duplicateId: row.burst_group_id,
      };
    });
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

/** Copy Buffer bytes into a properly aligned Float32Array. */
function copyToFloat32Array(buf: Buffer): Float32Array {
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(aligned);
}

function parseFacetDate(dateStr: string | null): Date {
  if (!dateStr) return new Date(0);
  // Facet format: "2025:02:20 08:00:27"
  const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  return new Date(normalized);
}
