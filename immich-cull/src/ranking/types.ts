/** LLM response types for day-batch photo review */

export type LlmCategory =
  | "portrait" | "group_portrait" | "selfie"
  | "landscape" | "travel" | "event" | "pet" | "action"
  | "document" | "receipt" | "whiteboard"
  | "screenshot" | "snapchat_save"
  | "technical_construction" | "vehicle" | "food" | "meme" | "other";

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
  suggestedStars: 0 | 1 | 2 | 3;
  categories: LlmCategory[];
  briefNote: string;
  similaritySubgroupId: string | null;
  llmKeepCull: 'keep' | 'cull' | null;
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
