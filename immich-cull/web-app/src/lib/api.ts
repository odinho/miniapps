/** API client for the immich-cull server */

const BASE = ""; // same origin

export interface GroupSummary {
  id: string;
  index: number;
  count: number;
  timeSpanMinutes: number;
  avgDistance: number;
  decided: boolean;
  earliestDate: number;
  totalBytes: number;
  assets: AssetSummary[];
}

export interface AssetSummary {
  id: string;
  filename: string;
  date: string;
  rating: number | null;
  isFavorite: boolean;
  bytes: number;
}

export interface GroupDetail {
  id: string;
  count: number;
  timeSpanMinutes: number;
  avgDistance: number;
  totalBytes: number;
  decision: { keep: string[]; cull: string[]; skipped: boolean } | null;
  assets: AssetDetail[];
}

export interface AssetDetail extends AssetSummary {
  path: string;
  w: number;
  h: number;
}

export interface AutoCullClassification {
  assetId: string;
  tier: "auto-cull-high" | "auto-cull" | "review";
  reason: string;
}

export interface AutoCullSummary {
  autoCullHigh: number;
  autoCull: number;
  review: number;
  total: number;
  classifications: AutoCullClassification[];
}

export interface BatchSummary {
  id: string;
  source: string;
  folderName: string | null;
  count: number;
  dateRange: { start: string; end: string };
  hasLlmResult: boolean;
  viewStatus: string | null;
  keeps: number;
  culls: number;
  autoCullStats: { autoCullHigh: number; autoCull: number; review: number } | null;
}

export interface BatchDetail {
  id: string;
  source: string;
  folderName: string | null;
  count: number;
  dateRange: { start: string; end: string };
  assets: AssetDetail[];
  llm: LlmResult | null;
  llmModels?: string[];
  autoCull: AutoCullSummary | null;
}

export interface LlmResult {
  model?: string;
  batchSummary: string;
  overallConfidence: number;
  images: LlmImage[];
  similaritySubgroups: LlmSubgroup[];
}

export interface LlmImage {
  imageId: string;
  suggestedStars: number;
  categories: string[];
  briefNote: string;
  llmKeepCull: "keep" | "cull" | null;
  similaritySubgroupId: string | null;
}

export interface LlmSubgroup {
  subgroupId: string;
  imageIds: string[];
  subgroupType: string;
  recommendedKeepCount: number;
  recommendedKeepIds: string[];
  cullIds: string[];
  rationale: string;
}

export interface Stats {
  totalGroups: number;
  decided: number;
  skipped: number;
  photosToKeep: number;
  photosToCull: number;
  remaining: number;
  cullBytes: number;
}

export async function fetchGroups(): Promise<GroupSummary[]> {
  return (await fetch(`${BASE}/api/groups`)).json();
}

export async function fetchGroup(id: string): Promise<GroupDetail> {
  return (await fetch(`${BASE}/api/groups/${id}`)).json();
}

export async function decideGroup(id: string, keep: string[], cull: string[], skipped = false) {
  return (
    await fetch(`${BASE}/api/groups/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep, cull, skipped }),
    })
  ).json();
}

export async function undecideGroup(id: string) {
  return (await fetch(`${BASE}/api/groups/${id}/decide`, { method: "DELETE" })).json();
}

export async function fetchStats(): Promise<Stats> {
  return (await fetch(`${BASE}/api/stats`)).json();
}

export async function fetchBatches(): Promise<{
  batches: BatchSummary[];
  recentlyReviewed: string[];
}> {
  return (await fetch(`${BASE}/api/batches`)).json();
}

export async function fetchBatch(id: string, model?: string): Promise<BatchDetail> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  return (await fetch(`${BASE}/api/batches/${id}${qs}`)).json();
}

export async function savePhotoDecisions(
  decisions: Array<{
    assetId: string;
    state: string | null;
    userStars: number | null;
    starSource?: string;
  }>,
) {
  return (
    await fetch(`${BASE}/api/photos/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    })
  ).json();
}

export async function fetchPhotoDecisions(
  assetIds: string[],
): Promise<Record<string, { state: string | null; userStars: number | null }>> {
  return (
    await fetch(`${BASE}/api/photos/decisions/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetIds }),
    })
  ).json();
}

export async function rankBatch(id: string, model?: string) {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  return (await fetch(`${BASE}/api/batches/${id}/rank${qs}`, { method: "POST" })).json();
}

export async function autoApproveBatches(
  batchIds: string[],
  model?: string,
): Promise<{
  ok: boolean;
  results: Array<{ batchId: string; approved: number; skipped: number; error?: string }>;
}> {
  return (
    await fetch(`${BASE}/api/batches/auto-approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchIds, model }),
    })
  ).json();
}

export async function revertAutoApprovals(): Promise<{ ok: boolean; reverted: number }> {
  return (await fetch(`${BASE}/api/auto-approve`, { method: "DELETE" })).json();
}

export interface CullComparison {
  cullId: string;
  cullFilename: string;
  cullStars: number;
  cullNote: string;
  cullCategory: string;
  keepers: Array<{ id: string; filename: string; stars: number; note: string }>;
  subgroupType: string;
  subgroupSize: number;
  subgroupReason: string;
  rank: number;
}

export async function fetchCullComparisons(
  batchId: string,
  model?: string,
): Promise<{ comparisons: CullComparison[] }> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  return (await fetch(`${BASE}/api/batches/${batchId}/cull-comparisons${qs}`)).json();
}

export async function stagedCull(
  batchIds: string[],
  stage: "safe" | "all" = "safe",
  model?: string,
): Promise<{
  ok: boolean;
  results: Array<{ batchId: string; autoCulled: number; forReview: number; skipped: number }>;
}> {
  return (
    await fetch(`${BASE}/api/batches/staged-cull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchIds, stage, model }),
    })
  ).json();
}

export interface ReviewPhoto {
  id: string;
  filename: string;
  path: string;
  date: string;
  w: number;
  h: number;
  bytes: number;
  stars: number;
  note: string;
  category: string;
  llmAction: "keep" | "cull";
}

export interface ReviewGroup {
  batchId: string;
  subgroupId: string;
  subgroupType: string;
  rationale: string;
  batchSummary: string;
  photos: ReviewPhoto[];
  tier: "high" | "standard" | "review";
}

export async function fetchReviewGroups(): Promise<{
  groups: ReviewGroup[];
  total: number;
  tierCounts: { high: number; standard: number; review: number };
}> {
  return (await fetch(`${BASE}/api/review-groups`)).json();
}

export function previewUrl(id: string): string {
  return `${BASE}/api/preview?id=${encodeURIComponent(id)}`;
}

export function fullUrl(id: string): string {
  return `${BASE}/api/full?id=${encodeURIComponent(id)}`;
}

export function fmt(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + " KB";
  return bytes + " B";
}
