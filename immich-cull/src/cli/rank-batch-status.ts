#!/usr/bin/env tsx
/**
 * Check a Vertex AI batch prediction job's status and ingest results when done.
 *
 * Usage:
 *   npm run rank:batch:status -- --sidecar /tmp/batch-job-<timestamp>.json
 *
 * If --sidecar is omitted, picks the most recent /tmp/batch-job-*.json.
 *
 * What it does:
 *   1. Looks up the job by name via @google/genai
 *   2. Prints state, timing, completion stats
 *   3. If SUCCEEDED: downloads the output JSONL via gcloud storage, parses
 *      each line, POSTs results to /api/batches/:id/llm-run
 *   4. Reports stats
 */
import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { GoogleGenAI, type JobState } from "@google/genai";

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

function findLatestSidecar(): string {
  const candidates = readdirSync("/tmp")
    .filter((f) => f.startsWith("batch-job-") && f.endsWith(".json"))
    .map((f) => ({ path: `/tmp/${f}`, mtime: statSync(`/tmp/${f}`).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    console.error("No sidecar files found in /tmp — pass --sidecar explicitly");
    process.exit(1);
  }
  return candidates[0].path;
}

const sidecarPath = getArg("--sidecar", "") || findLatestSidecar();
const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");

interface Sidecar {
  jobName: string;
  model: string;
  project: string;
  location: string;
  gcsInput: string;
  gcsOutputPrefix: string;
  batchIds: string[];
  submittedAt: string;
  lineCount: number;
}

async function main() {
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as Sidecar;
  console.log(`Sidecar: ${sidecarPath}`);
  console.log(`Job: ${sidecar.jobName} (${sidecar.lineCount} requests)`);
  console.log(`Submitted: ${sidecar.submittedAt}`);

  const ai = new GoogleGenAI({
    vertexai: true,
    project: sidecar.project,
    location: sidecar.location,
  });
  const job = await ai.batches.get({ name: sidecar.jobName });
  console.log(`State: ${job.state}`);
  if (job.startTime) console.log(`Started: ${job.startTime}`);
  if (job.endTime) console.log(`Ended:   ${job.endTime}`);

  const doneStates: JobState[] = [
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
  ] as JobState[];
  if (job.state && !doneStates.includes(job.state)) {
    console.log("\nJob still running — try again later.");
    return;
  }

  if (job.state === "JOB_STATE_FAILED" || job.state === "JOB_STATE_CANCELLED") {
    console.log("\nJob did not succeed:");
    console.log(JSON.stringify(job.error, null, 2));
    return;
  }

  // Success — download and ingest results
  console.log(`\nDownloading results from ${sidecar.gcsOutputPrefix}...`);
  // Vertex writes prediction.results-NNNNN-of-MMMMM files (possibly sharded)
  const listOut = execSync(`gcloud storage ls ${sidecar.gcsOutputPrefix}`).toString();
  const resultFiles = listOut
    .split("\n")
    .filter((l) => l.includes("predictions.jsonl") || l.includes("prediction.results"))
    .map((l) => l.trim())
    .filter(Boolean);

  if (!resultFiles.length) {
    console.log("No result files found. Output dir contents:");
    console.log(listOut);
    return;
  }

  // Concatenate all shards — Vertex preserves input order within shards
  const combined: string[] = [];
  for (const file of resultFiles) {
    const body = execSync(`gcloud storage cat ${file}`).toString();
    combined.push(...body.split("\n").filter(Boolean));
  }
  console.log(`Got ${combined.length} result lines (expected ${sidecar.lineCount})`);

  if (combined.length !== sidecar.lineCount) {
    console.warn(`WARN: line count mismatch — output order may not match input`);
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < combined.length; i++) {
    const batchId = sidecar.batchIds[i];
    if (!batchId) {
      console.warn(`  line ${i}: no matching batch ID in sidecar, skipping`);
      continue;
    }
    try {
      const row = JSON.parse(combined[i]);
      if (row.status && row.status !== "") {
        console.warn(`  ${batchId}: ${row.status}`);
        failed++;
        continue;
      }
      const candidates = row.response?.candidates ?? [];
      const text = candidates[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.warn(`  ${batchId}: no response text`);
        failed++;
        continue;
      }
      const usage = row.response?.usageMetadata ?? {};
      // eslint-disable-next-line no-await-in-loop -- intentional: sequential POSTs to avoid overwhelming server
      const postResp = await fetch(`${server}/api/batches/${batchId}/llm-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: sidecar.model,
          promptVersion: "v3",
          rawJson: text,
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
        }),
      });
      if (!postResp.ok) {
        console.warn(`  ${batchId}: server rejected (HTTP ${postResp.status})`);
        failed++;
        continue;
      }
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${batchId}: ${msg}`);
      failed++;
    }
    process.stdout.write(
      `\r  ingested ${ok + failed}/${combined.length} (ok=${ok} fail=${failed})`,
    );
  }
  process.stdout.write("\n");

  console.log(`\n=== Complete ===`);
  console.log(`Ingested: ${ok}, Failed: ${failed}`);
}

await main();
