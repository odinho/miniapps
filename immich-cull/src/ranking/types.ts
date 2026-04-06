/** LLM response types for day-batch photo review */

export type LlmCategory =
  | "portrait" | "group_portrait" | "selfie"
  | "landscape" | "travel" | "event" | "pet" | "action"
  | "document" | "receipt" | "whiteboard"
  | "screenshot" | "snapchat_save"
  | "technical_construction" | "vehicle" | "food" | "meme" | "other";

export type ProtectionReason =
  | "existing_star_protection" | "personal_memory" | "utility_reference"
  | "partner_shared_image" | "distinct_moment" | "no_special_protection";

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
  protectFromCull: boolean;
  protectionReason: ProtectionReason;
  briefNote: string;
  similaritySubgroupId: string | null;
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
