/** LLM response types for day-batch photo review */

export type LlmCategory =
  | "portrait"
  | "group_portrait"
  | "selfie"
  | "landscape"
  | "travel"
  | "event"
  | "pet"
  | "action"
  | "document"
  | "receipt"
  | "whiteboard"
  | "screenshot"
  | "snapchat_save"
  | "technical_construction"
  | "vehicle"
  | "food"
  | "meme"
  | "other";

export interface DayBatchResponse {
  batchId: string;
  batchSize: number;
  dateRange: string;
  batchSummary: string;
  overallConfidence: number;
  images: ImageAssessment[];
  similaritySubgroups: SimilaritySubgroup[];
}

export interface ImageAssessment {
  imageId: string;
  suggestedStars: number; // 0-5 from LLM
  categories: LlmCategory[];
  briefNote: string;
  similaritySubgroupId: string | null;
  llmKeepCull: "keep" | "cull" | null;
}

/**
 * Map LLM 0-5 stars to Immich 0-3 stars.
 *
 * Shift-1 mapping: LLM uses full 0-5 for discrimination, but LLMs
 * rarely give 4-5★. Shifting by 1 gives a better Immich distribution:
 *   LLM 0-1 → 0★ (unstarred filler, ~72% of photos)
 *   LLM 2   → 1★ (good photo, stands out, ~20%)
 *   LLM 3   → 2★ (share-worthy, ~7%)
 *   LLM 4-5 → 3★ (exceptional/gallery-worthy, ~0.5%)
 */
export function mapLlmStarsToWriteback(llmStars: number): number {
  if (llmStars <= 1) return 0;
  if (llmStars >= 4) return 3;
  return llmStars - 1; // 2→1, 3→2
}

export interface SimilaritySubgroup {
  subgroupId: string;
  imageIds: string[];
  subgroupType: "burst" | "near_duplicate" | "same_scene" | "same_subject";
  recommendedKeepCount: number;
  recommendedKeepIds: string[];
  cullIds: string[];
  rationale: string;
  confidence: number;
}
