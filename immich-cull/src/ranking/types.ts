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

/** Map LLM 0-5 stars to write-back 0-3 stars: LLM 0-2→0, 3→1, 4→2, 5→3 */
export function mapLlmStarsToWriteback(llmStars: number): number {
  if (llmStars <= 2) return 0;
  return llmStars - 2; // 3→1, 4→2, 5→3
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
