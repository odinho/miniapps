#!/usr/bin/env npx tsx
/**
 * Burst-quality classifier — a pre-LLM filter that scores whether a burst
 * subgroup looks like a *real* burst (tight temporal + semantic grouping of
 * the same moment) or a *pseudo-burst* (e.g. screenshots grouped by clock
 * proximity alone).
 *
 * Motivation: during grading 2026-04-19, the user excluded a subgroup of
 * 4 unrelated app screenshots that were grouped purely by timestamp. This
 * kind of group silently pollutes all metrics (local models pick a
 * "best" screenshot which is semantically meaningless).
 *
 * Features (all cheap, no GPU):
 *   - fraction of filenames matching /screenshot/i
 *   - paths containing "/Screenshots/" or "/Screen Recordings/" (when available)
 *   - time spread across the group (seconds between min/max file-created-at)
 *   - aspect-ratio variance (screenshots are often all 9:19.5; photos vary)
 *
 * Output: per-subgroup score + verdict (real / suspicious / pseudo).
 *
 * Usage:
 *   npx tsx scripts/burst_quality_classifier.ts [--server http://localhost:3737]
 */

import { setGlobalDispatcher, Agent } from "undici";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");

interface Asset {
  id: string;
  filename: string;
  path: string;
  date: string;
  w: number;
  h: number;
}

interface Score {
  batchId: string;
  subgroupId: string;
  subgroupType: string;
  n: number;
  screenshotRatio: number;
  screenshotPathRatio: number;
  timeSpreadSec: number;
  aspectVariance: number;
  pseudoScore: number; // 0 = real, 1 = pseudo
  verdict: "real" | "suspicious" | "pseudo";
  sampleFilename: string;
}

function variance(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
}

function scoreSubgroup(
  batchId: string,
  subgroupId: string,
  subgroupType: string,
  assets: Asset[],
): Score {
  const n = assets.length;
  const screenshotNameMatches = assets.filter((a) =>
    /screenshot/i.test(a.filename),
  ).length;
  const screenshotPathMatches = assets.filter((a) =>
    /\/(Screenshots?|Screen Recordings)\//i.test(a.path),
  ).length;
  const screenshotRatio = screenshotNameMatches / n;
  const screenshotPathRatio = screenshotPathMatches / n;

  const dates = assets
    .map((a) => new Date(a.date).getTime())
    .filter((t) => !Number.isNaN(t));
  const timeSpreadSec =
    dates.length >= 2
      ? (Math.max(...dates) - Math.min(...dates)) / 1000
      : 0;

  const aspects = assets
    .filter((a) => a.w && a.h)
    .map((a) => a.w / a.h);
  const aspectVar = variance(aspects);

  // Heuristic score: 0 = clearly real burst, 1 = clearly pseudo-burst.
  // Signals:
  //   +0.6 if >=50% are screenshots by filename
  //   +0.3 if paths point to a Screenshots folder
  //   +0.2 if n>=3 and aspect variance is ~0 (all identical screenshot aspect)
  //   +0.1 if time spread is very wide (>300s) for a small group
  //   -0.1 if time spread is tight (<30s) — real burst signal
  let pseudo = 0;
  if (screenshotRatio >= 0.5) pseudo += 0.6;
  if (screenshotPathRatio >= 0.5) pseudo += 0.3;
  if (n >= 3 && aspectVar < 0.0005 && screenshotRatio >= 0.5) pseudo += 0.2;
  if (timeSpreadSec > 300 && n <= 5) pseudo += 0.1;
  if (timeSpreadSec > 0 && timeSpreadSec < 30) pseudo -= 0.1;
  pseudo = Math.max(0, Math.min(1, pseudo));

  const verdict: Score["verdict"] =
    pseudo >= 0.6 ? "pseudo" : pseudo >= 0.3 ? "suspicious" : "real";

  return {
    batchId,
    subgroupId,
    subgroupType,
    n,
    screenshotRatio,
    screenshotPathRatio,
    timeSpreadSec,
    aspectVariance: aspectVar,
    pseudoScore: pseudo,
    verdict,
    sampleFilename: assets[0]?.filename ?? "",
  };
}

async function fetchAssets(ids: string[]): Promise<Asset[]> {
  if (!ids.length) return [];
  const qs = new URLSearchParams({ ids: ids.join(",") });
  const r = await fetch(`${server}/api/assets/details?${qs}`);
  const j = (await r.json()) as { assets: Asset[] };
  return j.assets;
}

async function main() {
  console.log("=== Burst-quality classifier ===");

  // Walk all batches that have LLM results and classify each subgroup.
  const batchesResp = await (
    await fetch(`${server}/api/batches`)
  ).json();
  const batches = batchesResp.batches as Array<{
    id: string;
    hasLlmResult: boolean;
  }>;
  console.log(`${batches.length} batches total`);

  const scores: Score[] = [];
  let processed = 0;
  for (const b of batches) {
    if (!b.hasLlmResult) continue;
    processed++;
    const d = await (await fetch(`${server}/api/batches/${b.id}`)).json();
    const assetById = new Map<string, Asset>();
    for (const a of d.assets ?? []) {
      assetById.set(a.id, {
        id: a.id,
        filename: a.filename,
        path: a.path,
        date: a.date,
        w: a.w,
        h: a.h,
      });
    }
    for (const sg of d.llm?.similaritySubgroups ?? []) {
      const sgAssets = (sg.imageIds ?? [])
        .map((id: string) => assetById.get(id))
        .filter((a: Asset | undefined): a is Asset => !!a);
      if (sgAssets.length < 2) continue;
      scores.push(
        scoreSubgroup(b.id, sg.subgroupId, sg.subgroupType ?? "unknown", sgAssets),
      );
    }
    if (processed % 200 === 0) console.log(`  processed ${processed} batches...`);
  }

  console.log(`\nScored ${scores.length} subgroups across ${processed} batches`);
  const pseudo = scores.filter((s) => s.verdict === "pseudo").length;
  const suspicious = scores.filter((s) => s.verdict === "suspicious").length;
  const real = scores.filter((s) => s.verdict === "real").length;
  console.log(`  pseudo: ${pseudo}`);
  console.log(`  suspicious: ${suspicious}`);
  console.log(`  real: ${real}`);

  // Top pseudo candidates
  console.log("\n=== Top 30 pseudo-bursts (candidates to auto-exclude) ===");
  for (const s of scores.filter((x) => x.verdict !== "real").toSorted((a, b) => b.pseudoScore - a.pseudoScore).slice(0, 30)) {
    console.log(
      `  [${s.pseudoScore.toFixed(2)} ${s.verdict}] ${s.batchId}/${s.subgroupId} n=${s.n} ss=${(s.screenshotRatio * 100).toFixed(0)}% path=${(s.screenshotPathRatio * 100).toFixed(0)}% spread=${s.timeSpreadSec.toFixed(0)}s aspvar=${s.aspectVariance.toFixed(4)} — ${s.sampleFilename}`,
    );
  }

  const outPath = resolve(
    __dirname,
    "../data/experiments/2026-04-20-burst-quality-scores.json",
  );
  writeFileSync(outPath, JSON.stringify({ processed, scores }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
