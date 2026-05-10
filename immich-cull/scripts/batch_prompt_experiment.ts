#!/usr/bin/env npx tsx
/**
 * Batch-level prompt experiment: judge a whole day-batch in one shot and mark
 * each photo keep/cull. Tests prompts that bypass the subgroup decomposition.
 *
 * Output shape matches scripts/prompt_v2_experiment.ts so the existing
 * ExperimentGrader can load it unchanged: {results: [{group, variants: [...]}]}.
 * Here "group" is the whole batch; bestPicks indices are into the full batch.
 *
 * Context-length strategy for local models:
 *   - Large previews (1200px) would blow 32k ctx around 10-15 photos.
 *   - Local models use --local-preview (default 640px) to keep batches feasible.
 *   - Cloud models use --cloud-preview (default 1024px).
 *   - Batches larger than --max-photos are skipped per variant (noted in output).
 *
 * Baseline "v1_prod" variant is read from the cached production LLM run, so we
 * don't have to re-execute v1 — we just materialise its keeps as a pick set.
 *
 * Usage:
 *   npx tsx scripts/batch_prompt_experiment.ts \
 *     --batches 20 --prompt batch_adaptive \
 *     --models v1_prod,31flashlite,qwen_terse --max-photos 40
 */

import { GoogleGenAI } from "@google/genai";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readFileSync, existsSync } from "fs";
import Database from "better-sqlite3";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(
  new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30000 }),
);

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const server = getArg("--server", "http://localhost:3737").replace(/\/$/, "");
const OLLAMA_URL = getArg("--ollama", "http://localhost:11434");
const promptKind = getArg("--prompt", "batch_adaptive");
const modelsCsv = getArg("--models", "v1_prod,31flashlite_batch,qwen_terse_batch");
const maxBatches = parseInt(getArg("--batches", "20"), 10);
// Default effectively off — the session batcher caps at 30 photos natively.
// Keep the flag as an escape hatch but don't use it in normal runs.
const maxPhotos = parseInt(getArg("--max-photos", "10000"), 10);
const minPhotos = parseInt(getArg("--min-photos", "8"), 10);
const cloudPreview = parseInt(getArg("--cloud-preview", "1024"), 10);
const localPreview = parseInt(getArg("--local-preview", "640"), 10);
const userCoverageMin = parseFloat(getArg("--user-coverage", "0.7"));

const outPath = resolve(
  __dirname,
  `../data/experiments/2026-04-20-batch-${promptKind}.json`,
);

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

const BATCH_ADAPTIVE = `You review a batch of personal/family photos from one session (one event, one place, usually one day).

These are family memories. Judge people first — faces, expressions, interactions. Background scenery is secondary when people are in frame. When torn, keep rather than cull — the user trims later.

For EACH photo, decide keep (k) or cull (c):
- KEEP if it captures a distinct moment, person, expression, interaction, or reference.
- KEEP if it's the best of a near-identical burst.
- CULL if it's a near-duplicate of a frame you already chose to keep (pick 1 keeper per burst unless multiple frames show genuinely distinct expressions/stages).
- CULL if it's blurry, out-of-focus on the main subject, badly cropped, or truly empty of interest.

Typical target: 40-60% kept. A batch of bursts might keep 20-30%. A batch of diverse moments might keep 70-80%.

Return JSON:
{"keep": [0-based indices you would keep], "reason": "one sentence on your overall approach"}

Indices match the order the photos are shown in.`;

const BATCH_PRIORITIES = `You judge a session of family photos (one event or day).

PRIORITIES (highest first):
1. People & faces — who is in the photo, are eyes open, expression clear?
2. Moment — unique interaction, peak action, a distinct stage of an event.
3. Sharpness — subject in focus.
4. Composition — framed well.
5. Environment — scenery/establishing shots are secondary to people.

RULES:
- For any cluster of near-identical frames (burst, duplicate poses), keep 1 by default. Keep a 2nd only if the 2nd shows a clearly different expression, stage, or face you'd otherwise lose.
- Keep all frames that show a distinct person or moment, even if imperfect.
- Cull blurry, mis-focused, badly-cropped, or accidental photos.
- Prefer keeping over losing a good memory — this user regrets losses more than excess keeps.

Return JSON:
{"keep": [0-based keep indices], "reason": "brief summary of approach"}`;

const BATCH_MIN = `Decide which photos from this session to keep (k) vs cull (c). Be generous on unique moments; cull near-duplicates and technical failures.

Return JSON: {"keep": [indices], "reason": "brief"}. Indices 0-based.`;

// v1's rich priority framing, but asking for a flat batch decision (no subgroup/stars/categories).
// Tests whether the win comes from v1's *detail* or its *specific framing*.
const BATCH_V1_STYLE = `You review a batch of personal/family photos from a single session (one event, one place, usually one day).

PRIORITY:
These are family memory photos. Judge people first — faces, expressions, interaction, children.
Background scenery (grass, trail, trees, sky) is secondary unless no people are visible.
If people are visible, note them first. Do not reduce a family photo to "path with grass."

KEEP vs CULL:
Aim to keep roughly 50-60% on average. When in doubt, keep — the user prefers having too many photos over losing a good one.
A session of 10 near-identical bursts might keep 2-3 (20-30%), a session of diverse moments might keep 80%.

Within a burst (near-identical frames): keep 1-2 photos that complement each other (different expression, different face, different stage of action, different framing). Keep 3+ only for action sequences showing clearly distinct stages. Cull the near-duplicates that add nothing.

Singletons / unique moments:
- Keep if it captures a distinct moment, memory, or reference.
- Cull if blurry, accidental, or truly empty.

Category-specific nudges:
- Action sequences: keep 2-3 frames showing different stages.
- Portraits/groups: keep the 1-2 best expressions.
- Food: keep one representative shot per meal.
- Screenshots/technical/documents: keep if useful reference — don't blanket cull these.
- Snapchat/social saves: keep if they have genuine social or memory value.

Return JSON only:
{"keep": [0-based indices to keep], "reason": "one sentence on your overall approach"}

Indices match the order the photos are shown in.`;

const PROMPTS: Record<string, string> = {
  batch_adaptive: BATCH_ADAPTIVE,
  batch_priorities: BATCH_PRIORITIES,
  batch_min: BATCH_MIN,
  batch_v1_style: BATCH_V1_STYLE,
  // batch_prod is a baseline kind: no prompt, only v1_prod cached picks. Produces a
  // standalone baseline experiment file so the user can grade v1 once and have those
  // grades inherit into every other batch-* experiment for identical picks.
  batch_prod: "",
};

const PROMPT = PROMPTS[promptKind];
if (PROMPT === undefined) {
  console.error(
    `Unknown prompt: ${promptKind}. Use: ${Object.keys(PROMPTS).join(" | ")}`,
  );
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Variants
// ----------------------------------------------------------------------------

type ModelSpec = {
  name: string;
  provider: "ollama" | "vertexai" | "v1_prod";
  model?: string;
  think?: boolean;
  numPredict?: number;
};

const ALL_MODELS: Record<string, ModelSpec> = {
  v1_prod: { name: "v1_prod", provider: "v1_prod" },
  qwen_terse_batch: {
    name: `qwen36_a3b_terse_batch_${promptKind}`,
    provider: "ollama",
    model: "qwen3.6:35b-a3b",
    think: false,
  },
  gemma4_31b_batch: {
    name: `gemma4_31b_batch_${promptKind}`,
    provider: "ollama",
    model: "gemma4:31b",
  },
  gemma4_e4b_batch: {
    name: `gemma4_e4b_batch_${promptKind}`,
    provider: "ollama",
    model: "gemma4:e4b",
  },
  "31flashlite_batch": {
    name: `31flashlite_batch_${promptKind}`,
    provider: "vertexai",
    model: "gemini-3.1-flash-lite-preview",
  },
  "3flash_batch": {
    name: `3flash_batch_${promptKind}`,
    provider: "vertexai",
    model: "gemini-3-flash-preview",
  },
};

const VARIANTS: ModelSpec[] = modelsCsv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((k) => {
    const v = ALL_MODELS[k];
    if (!v) {
      console.error(
        `Unknown model key: ${k}. Known: ${Object.keys(ALL_MODELS).join(",")}`,
      );
      process.exit(1);
    }
    return v;
  });

// ----------------------------------------------------------------------------
// API helpers
// ----------------------------------------------------------------------------

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
  return resp.json();
}

async function getImageBase64(assetId: string, px: number): Promise<string> {
  // Retry on transient failures (server restart, brief network blip).
  // Empty-string fallback would feed garbage to the LLM — much better to wait.
  let lastErr: unknown = null;
  for (const delay of [0, 1000, 3000, 7000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const resp = await fetch(
        `${server}/api/preview?id=${encodeURIComponent(assetId)}&w=${px}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!resp.ok) throw new Error(`preview ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer()).toString("base64");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("preview fetch failed");
}

// ----------------------------------------------------------------------------
// LLM runners
// ----------------------------------------------------------------------------

async function runOllama(
  variant: ModelSpec,
  ids: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const userPrompt =
    `${ids.length} photos from a single session. Choose which to keep.\n\n` +
    ids.map((_, i) => `Image ${i}`).join("\n");
  const body: Record<string, unknown> = {
    model: variant.model,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: userPrompt, images: imagesB64 },
    ],
    stream: true,
    format: "json",
    keep_alive: "30m",
    options: {
      temperature: 0,
      num_predict: variant.numPredict ?? 3000,
      num_ctx: 32768,
    },
  };
  if (variant.think !== undefined) body.think = variant.think;

  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1_800_000),
  });
  if (!resp.ok || !resp.body) throw new Error(`Ollama ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let promptEvalCount = 0;
  let evalCount = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.message?.content) content += j.message.content;
        if (j.done) {
          promptEvalCount = j.prompt_eval_count ?? promptEvalCount;
          evalCount = j.eval_count ?? evalCount;
        }
      } catch { /* partial */ }
    }
  }
  return { raw: content, tokensIn: promptEvalCount, tokensOut: evalCount };
}

async function runGemini(
  variant: ModelSpec,
  _ids: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "tagrdevin",
    location: "global",
  });
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    {
      text: PROMPT + `\n\n${imagesB64.length} photos from this session.\n`,
    },
  ];
  for (let i = 0; i < imagesB64.length; i++) {
    parts.push({ text: `--- Image ${i} ---` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: imagesB64[i] } });
  }
  parts.push({ text: "Return your JSON verdict." });
  const result = await ai.models.generateContent({
    model: variant.model!,
    contents: [{ role: "user", parts }],
    config: {
      temperature: 0,
      maxOutputTokens: 4000,
      responseMimeType: "application/json",
    },
  });
  return {
    raw: result.text ?? "",
    tokensIn: result.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: result.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

function parseResponse(
  raw: string,
  n: number,
): { keep: number[]; reason: string } {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) parsed = JSON.parse(m[1]);
    else {
      const obj = stripped.match(/\{[\s\S]*\}/);
      if (!obj) throw new Error("JSON parse failed");
      parsed = JSON.parse(obj[0]);
    }
  }
  const rawKeep = Array.isArray(parsed.keep)
    ? parsed.keep
    : Array.isArray((parsed as any).best)
    ? (parsed as any).best
    : [];
  const keep = (rawKeep as unknown[])
    .filter((i): i is number => typeof i === "number" && i >= 0 && i < n)
    .toSorted((a, b) => a - b);
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { keep, reason };
}

// ----------------------------------------------------------------------------
// Batch selection
// ----------------------------------------------------------------------------

type BatchPick = {
  batchId: string;
  assetIds: string[];
  filenames: string[];
  userKeepIds: string[];
  userCullIds: string[];
  v1KeepIds: string[]; // from production LLM cache
};

async function selectBatches(userDecisions: Map<string, string>): Promise<BatchPick[]> {
  const resp = await fetchJson(`${server}/api/batches`);
  const all: Array<{ id: string; hasLlmResult: boolean; count: number }> = resp.batches;

  const picks: BatchPick[] = [];
  for (const b of all) {
    if (!b.hasLlmResult) continue;
    if (b.count < minPhotos || b.count > maxPhotos) continue;
    if (picks.length >= maxBatches) break;

    const detail = await fetchJson(`${server}/api/batches/${b.id}`);
    if (!detail.llm) continue;

    const assetIds: string[] = detail.assets.map((a: any) => a.id);
    const filenames: string[] = detail.assets.map((a: any) => a.filename);

    // User decision coverage
    const userKeep: string[] = [];
    const userCull: string[] = [];
    for (const id of assetIds) {
      const d = userDecisions.get(id);
      if (d === "keep") userKeep.push(id);
      else if (d === "cull") userCull.push(id);
    }
    const coverage = (userKeep.length + userCull.length) / assetIds.length;
    if (coverage < userCoverageMin) continue;

    // v1 keeps from cached prod LLM (API returns "imageId", not "id")
    const v1KeepIds: string[] = [];
    for (const img of detail.llm.images ?? []) {
      if (img.llmKeepCull === "keep") v1KeepIds.push(img.imageId ?? img.id);
    }

    picks.push({
      batchId: b.id,
      assetIds,
      filenames,
      userKeepIds: userKeep,
      userCullIds: userCull,
      v1KeepIds,
    });
  }

  console.log(`Selected ${picks.length} batches (min ${minPhotos}, max ${maxPhotos} photos, ≥${(userCoverageMin * 100).toFixed(0)}% user coverage)`);
  for (const p of picks) {
    console.log(
      `  ${p.batchId}: ${p.assetIds.length}p · user ${p.userKeepIds.length}k/${p.userCullIds.length}c · v1 ${p.v1KeepIds.length}k`,
    );
  }
  return picks;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  console.log("=== Batch-level prompt experiment ===");
  console.log(`Prompt: ${promptKind}`);
  console.log(`Variants: ${VARIANTS.map((v) => v.name).join(", ")}`);
  console.log(`Max photos per batch: ${maxPhotos}`);
  console.log(`Output: ${outPath}\n`);

  const db = new Database(
    resolve(__dirname, "../data/state.db"),
    { readonly: true },
  );
  const userDecisions = new Map<string, string>();
  for (const row of db
    .prepare(
      "SELECT asset_id, state FROM photo_decisions WHERE source = 'manual' AND state IS NOT NULL",
    )
    .all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();
  console.log(`User decisions: ${userDecisions.size}`);

  const batches = await selectBatches(userDecisions);
  if (!batches.length) {
    console.log("No suitable batches.");
    return;
  }

  // Resume support
  type Prior = { group: { batchId: string }; variants: Array<{ variant: string }> };
  let prior: Prior[] = [];
  if (existsSync(outPath)) {
    try {
      prior = JSON.parse(readFileSync(outPath, "utf-8")).results ?? [];
    } catch {
      prior = [];
    }
  }
  const priorByBatch = new Map<string, Prior>();
  for (const p of prior) priorByBatch.set(p.group.batchId, p);
  console.log(`Existing results: ${prior.length} batches\n`);

  // Preserve prior results from earlier runs that aren't in this run's selection.
  // Otherwise a narrower-criteria run (e.g. --max-photos 25) would truncate a broader
  // prior result set (e.g. --max-photos 60). Bug symptom before this fix: qwen's 25-photo
  // run overwrote the cloud 60-photo run's extra batches.
  const currentBatchIds = new Set(batches.map((b) => b.batchId));
  const allResults: Array<Record<string, unknown>> = [];
  for (const p of prior) {
    if (!currentBatchIds.has(p.group.batchId)) {
      allResults.push(p as Record<string, unknown>);
    }
  }
  if (allResults.length) {
    console.log(`  carrying forward ${allResults.length} prior batches outside current selection\n`);
  }

  for (const batch of batches) {
    const existing = priorByBatch.get(batch.batchId);
    const existingVariants = new Map<string, any>();
    if (existing) {
      for (const v of existing.variants as any[]) existingVariants.set(v.variant, v);
    }

    // Determine what we still need to run
    const needed = VARIANTS.filter((v) => !existingVariants.has(v.name));
    if (needed.length === 0) {
      console.log(`[SKIP] ${batch.batchId} — all variants complete`);
      allResults.push(existing!);
      continue;
    }

    console.log(`\n--- ${batch.batchId}: ${batch.assetIds.length}p ---`);

    // Image preload — do cloud-size first since both use the same preview endpoint
    const needsCloud = needed.some((v) => v.provider === "vertexai");
    const needsLocal = needed.some((v) => v.provider === "ollama");
    const cloudImages: string[] = [];
    const localImages: string[] = [];
    if (needsCloud) {
      for (const id of batch.assetIds) {
        try {
          cloudImages.push(await getImageBase64(id, cloudPreview));
        } catch {
          cloudImages.push("");
        }
      }
    }
    if (needsLocal) {
      for (const id of batch.assetIds) {
        try {
          localImages.push(await getImageBase64(id, localPreview));
        } catch {
          localImages.push("");
        }
      }
    }

    const variantResults: Array<Record<string, unknown>> = [];
    for (const v of existingVariants.values()) variantResults.push(v);

    const groupFor = (vr: typeof variantResults) => ({
      group: {
        batchId: batch.batchId,
        subgroupId: "whole-batch",
        type: "batch",
        assetIds: batch.assetIds,
        filenames: batch.filenames,
        llmKeepIds: batch.v1KeepIds,
        llmRanking: batch.assetIds,
        userKeepIds: batch.userKeepIds,
        userCullIds: batch.userCullIds,
      },
      variants: vr,
    });
    const snapshot = () => {
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            experimentType: "batch",
            completedBatches: allResults.length + 1,
            targetBatches: batches.length,
            variants: VARIANTS.map((v) => v.name),
            promptKind,
            prompt: PROMPT,
            results: [...allResults, groupFor(variantResults)],
          },
          null,
          2,
        ),
      );
    };

    for (const variant of needed) {
      const t0 = Date.now();
      let variantRow: Record<string, unknown>;

      if (variant.provider === "v1_prod") {
        const keepIdx = batch.v1KeepIds
          .map((id) => batch.assetIds.indexOf(id))
          .filter((i) => i >= 0)
          .toSorted((a, b) => a - b);
        const userMatches = keepIdx
          .map((i) => batch.assetIds[i])
          .some((id) => batch.userKeepIds.includes(id));
        variantRow = {
          variant: variant.name,
          bestPicks: keepIdx,
          ranking: [],
          reason: `v1 production LLM (cached): ${keepIdx.length} keeps`,
          elapsed: 0,
          matchesUser: batch.userKeepIds.length > 0 ? userMatches : null,
          matchesLlm: true,
          tokensIn: 0,
          tokensOut: 0,
        };
        console.log(`  ${variant.name}: ${keepIdx.length} keeps (cached v1)`);
      } else {
        let raw: string, tokensIn = 0, tokensOut = 0;
        try {
          const imgs = variant.provider === "vertexai" ? cloudImages : localImages;
          const r =
            variant.provider === "ollama"
              ? await runOllama(variant, batch.assetIds, imgs)
              : await runGemini(variant, batch.assetIds, imgs);
          raw = r.raw;
          tokensIn = r.tokensIn;
          tokensOut = r.tokensOut;
        } catch (err: unknown) {
          const msg = (err instanceof Error ? err.message : String(err)).slice(0, 140);
          console.log(`  ${variant.name}: ERROR — ${msg}`);
          variantRow = {
            variant: variant.name,
            bestPicks: [],
            ranking: [],
            reason: `ERROR: ${msg}`,
            elapsed: (Date.now() - t0) / 1000,
            matchesUser: null,
            matchesLlm: false,
            tokensIn: 0,
            tokensOut: 0,
          };
          variantResults.push(variantRow);
          snapshot();
          continue;
        }

        const elapsed = (Date.now() - t0) / 1000;
        let keep: number[] = [], reason = "";
        try {
          const p = parseResponse(raw, batch.assetIds.length);
          keep = p.keep;
          reason = p.reason;
        } catch {
          console.log(`  ${variant.name}: PARSE ERROR (${elapsed.toFixed(1)}s)`);
          variantRow = {
            variant: variant.name,
            bestPicks: [],
            ranking: [],
            reason: `PARSE ERROR: ${raw.slice(0, 140)}`,
            elapsed,
            matchesUser: null,
            matchesLlm: false,
            tokensIn,
            tokensOut,
          };
          variantResults.push(variantRow);
          snapshot();
          continue;
        }

        const pickedIds = keep.map((i) => batch.assetIds[i]);
        const userMatches =
          batch.userKeepIds.length > 0
            ? pickedIds.some((id) => batch.userKeepIds.includes(id))
            : null;
        const llmMatches = pickedIds.some((id) => batch.v1KeepIds.includes(id));

        console.log(
          `  ${variant.name}: kept ${keep.length}/${batch.assetIds.length} (${elapsed.toFixed(1)}s) — ${reason.slice(0, 60)}`,
        );

        variantRow = {
          variant: variant.name,
          bestPicks: keep,
          ranking: [],
          reason: reason || `Kept ${keep.length} of ${batch.assetIds.length}`,
          elapsed,
          matchesUser: userMatches,
          matchesLlm: llmMatches,
          tokensIn,
          tokensOut,
        };
      }

      variantResults.push(variantRow);
      snapshot();
    }

    allResults.push({
      group: {
        batchId: batch.batchId,
        subgroupId: "whole-batch",
        type: "batch",
        assetIds: batch.assetIds,
        filenames: batch.filenames,
        llmKeepIds: batch.v1KeepIds,
        llmRanking: batch.assetIds,
        userKeepIds: batch.userKeepIds,
        userCullIds: batch.userCullIds,
      },
      variants: variantResults,
    });
  }

  console.log("\n=== DONE ===");
  console.log(`Results: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
