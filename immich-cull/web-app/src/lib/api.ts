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

export interface BatchSummary {
  id: string;
  source: string;
  folderName: string | null;
  count: number;
  dateRange: { start: string; end: string };
  hasLlmResult: boolean;
  viewStatus: string | null;
}

export interface BatchDetail {
  id: string;
  source: string;
  folderName: string | null;
  count: number;
  dateRange: { start: string; end: string };
  assets: AssetDetail[];
  llm: LlmResult | null;
}

export interface LlmResult {
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

export async function fetchBatches(): Promise<BatchSummary[]> {
  return (await fetch(`${BASE}/api/batches`)).json();
}

export async function fetchBatch(id: string): Promise<BatchDetail> {
  return (await fetch(`${BASE}/api/batches/${id}`)).json();
}

export async function savePhotoDecisions(
  decisions: Array<{ assetId: string; state: string | null; userStars: number | null }>,
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

export async function rankBatch(id: string) {
  return (await fetch(`${BASE}/api/batches/${id}/rank`, { method: "POST" })).json();
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
