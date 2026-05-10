/** Core types for immich-cull */

export interface Asset {
  id: string;
  path: string;
  filename: string;
  fileCreatedAt: Date;
  embedding: Float32Array;
  rating: number | null;
  isFavorite: boolean;
  duplicateId: string | null;
  width?: number;
  height?: number;
  fileSize?: number;
}
