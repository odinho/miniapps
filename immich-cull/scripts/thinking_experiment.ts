#!/usr/bin/env npx tsx
/**
 * Thinking & Temperature Experiment
 *
 * Tests how thinking mode, temperature, and image resolution affect
 * LLM photo-culling accuracy for Gemma 4 (Ollama) and Gemini (Vertex AI).
 *
 * Results are saved to /tmp/thinking-experiment-<timestamp>.json — does NOT
 * touch state.db. Compares against existing user decisions (read-only).
 *
 * Usage:
 *   npx tsx scripts/thinking_experiment.ts [--batches 10] [--skip-gemini]
 *
 * Prerequisites:
 *   - immich-cull server running on localhost:3737
 *   - Ollama running on localhost:11434 with gemma4:e4b loaded
 *   - gcloud auth for Vertex AI (unless --skip-gemini)
 */

import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER = "http://localhost:3737";
const OLLAMA_URL = "http://localhost:11434";
const DB_PATH = join(__dirname, "..", "data", "state.db");

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const maxBatches = parseInt(getArg("--batches", "10"), 10);
const skipGemini = args.includes("--skip-gemini");
const skipOllama = args.includes("--skip-ollama");

// Production system prompt (same for all variants)
const SYSTEM_PROMPT = `You review a batch of personal/family photos from a single session.

PRIORITY:
These are family memory photos. Judge people first — faces, expressions, interaction, children.
Background scenery (grass, trail, trees, sky) is secondary unless no people are visible.
If people are visible, note them first. Do not reduce a family photo to "path with grass."

TASKS:
1. Assess EVERY photo — star rating + category + brief note + keep/cull recommendation.
2. Find similarity subgroups (variations of same moment) and rank within each.

STARS (0-5):
0 = extra/filler — technically fine but adds nothing unique. Most photos in a day are 0-star.
1 = good — stands out from the batch, worth keeping. A typical "nice photo."
2 = strong — noticeably better than average. Good composition, expression, or moment.
3 = excellent — one of the best from this session. Would share with family.
4 = exceptional — rarely given. Portfolio-quality or captures a truly special moment. Max 1-2 per batch.
5 = gallery-worthy — almost never given. Could be printed, sold, or exhibited. Most batches have zero 5-star photos.
Be STRICT: most photos should be 0-1. A batch of 10 typical family photos might have 7× 0-star, 2× 1-star, 1× 2-star.
Within subgroups: rate each photo ON ITS OWN MERIT — as if it were the only photo kept from that moment. Do NOT downgrade because similar photos exist. We post-process to assign stars only to the primary keeper. If the moment deserves 3★, the best photo in the subgroup should get 3★.
Photos with people usually outrank empty scenery from the same day.

KEEP vs CULL:
Aim to keep roughly 50-60% on average. When in doubt, keep — the user prefers having too many photos over losing a good one.
A batch of 10 near-identical bursts might keep 2-3 (20-30%), a batch of diverse moments might keep 80%.

Subgroups — balanced:
- Default to keeping 1-2 photos per subgroup. For subgroups of 5+, keep 2-3.
- Keep a second photo if it shows: a different expression, a different stage of the action, different framing, or captures a genuinely distinct moment.
- Action sequences (running, playing, interacting): keep 2-3 frames showing different stages of the action.
- Same-scene landscapes/environments: if the user took multiple shots, keep 2-3 variants unless they are truly identical.

Singletons:
- Keep if it captures a distinct moment, memory, or reference. Cull if blurry, accidental, or truly empty.

CRITICAL — grouping must be thorough:
- There should be very few singletons. If multiple photos are from the same scene, same time period, or same location — GROUP THEM even if they're not exact duplicates.
- Only leave a photo as a singleton if it is genuinely unrelated to every other photo in the batch.
- When in doubt, make the group.

Category-specific guidance:
- act (action): If 5+ photos of the same action, keep 2-3 showing different stages. Require clear subject or peak action.
- por/grp (portrait/group): Keep the 1-2 best expressions. A different expression or pose justifies a second keep.
- veh (vehicle): Cull unless it's a meaningful moment. Generic car detail shots → cull.
- snap (snapchat saves): Keep if it has genuine social/memory value. Cull disposable saves.
- food: Keep a representative photo of a meal if intentional. Don't keep every angle.
- ss/tech/doc (screenshot/technical/document): Keep if useful reference. The user values these more than you'd expect.

DESCRIPTIONS:
Every photo MUST get a UNIQUE note. If people visible, mention them first.

SIMILARITY GROUPING:
Group photos from the same scene or moment — same subject/location/activity, even if framing varies.
There should be very few singletons.

OUTPUT — compact JSON, indices 0..N-1 ONLY.
{
  "sum": "1-sentence summary",
  "img": [[i, stars, "cat", "3-5 word note", "sgId"|null, "k"|"c"], ...],
  "sg": [{"id":"g1", "type":"burst|dup|scene|subj", "all":[best,...worst], "keep":[kept], "why":"max 15 words"}, ...]
}
img tuple: [index, stars, "category", "note", subgroupId or null, "k" for keep or "c" for cull].
Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
"all" array: integers ordered best-first. "keep" array: STRICT SUBSET of "all".`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Variant {
  name: string;
  provider: "ollama" | "vertexai";
  model: string;
  temperature: number;
  think?: boolean; // Ollama
  thinkingLevel?: string; // Gemini: "minimal"|"low"|"medium"|"high"
  previewPx: number;
}

interface BatchDetail {
  id: string;
  assets: Array<{ id: string; filename: string; fileCreatedAt: string }>;
}

interface RunResult {
  variant: string;
  batchId: string;
  agree: number;
  total: number;
  wrongCull: number; // LLM culls, user keeps (dangerous!)
  wrongKeep: number; // LLM keeps, user culls (acceptable)
  keepRate: number;
  elapsed: number;
  tokensIn: number;
  tokensOut: number;
  thinkingChars: number;
  parseError: boolean;
  details: Array<{
    idx: number;
    filename: string;
    llm: string;
    user: string;
    match: boolean;
    stars: number;
    note: string;
  }>;
}

// ---------------------------------------------------------------------------
// Variants to test
// ---------------------------------------------------------------------------

const VARIANTS: Variant[] = [];

// Gemma 4 variants (Ollama)
if (!skipOllama) {
  VARIANTS.push(
    {
      name: "gemma4_baseline",
      provider: "ollama",
      model: "gemma4:e4b",
      temperature: 0.2,
      previewPx: 512,
    },
    {
      name: "gemma4_temp0",
      provider: "ollama",
      model: "gemma4:e4b",
      temperature: 0,
      previewPx: 512,
    },
    {
      name: "gemma4_think_512",
      provider: "ollama",
      model: "gemma4:e4b",
      temperature: 0,
      think: true,
      previewPx: 512,
    },
    {
      name: "gemma4_think_768",
      provider: "ollama",
      model: "gemma4:e4b",
      temperature: 0,
      think: true,
      previewPx: 768,
    },
    {
      name: "gemma4_think_1024",
      provider: "ollama",
      model: "gemma4:e4b",
      temperature: 0,
      think: true,
      previewPx: 1024,
    },
  );
}

// Gemini variants (Vertex AI)
if (!skipGemini) {
  VARIANTS.push(
    {
      name: "31flashlite_baseline",
      provider: "vertexai",
      model: "gemini-3.1-flash-lite-preview",
      temperature: 0.2,
      previewPx: 1200,
    },
    {
      name: "31flashlite_temp0",
      provider: "vertexai",
      model: "gemini-3.1-flash-lite-preview",
      temperature: 0,
      previewPx: 1200,
    },
    {
      name: "31flashlite_think_low",
      provider: "vertexai",
      model: "gemini-3.1-flash-lite-preview",
      temperature: 0,
      thinkingLevel: "low",
      previewPx: 1200,
    },
    {
      name: "31flashlite_think_high",
      provider: "vertexai",
      model: "gemini-3.1-flash-lite-preview",
      temperature: 0,
      thinkingLevel: "high",
      previewPx: 1200,
    },
    {
      name: "3flash_temp0",
      provider: "vertexai",
      model: "gemini-3-flash-preview",
      temperature: 0,
      previewPx: 1200,
    },
    {
      name: "3flash_think_low",
      provider: "vertexai",
      model: "gemini-3-flash-preview",
      temperature: 0,
      thinkingLevel: "low",
      previewPx: 1200,
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string, timeout = 10000): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

async function getImageBase64(assetId: string, px: number): Promise<string> {
  const resp = await fetch(
    `${SERVER}/api/preview?id=${encodeURIComponent(assetId)}&w=${px}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!resp.ok) throw new Error(`Preview fetch failed: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

function buildUserPrompt(batch: BatchDetail): string {
  const n = batch.assets.length;
  const meta = batch.assets.map((a, i) => ({ i, f: a.filename }));
  return `Session batch with ${n} images, indices 0-${n - 1}. Return EXACTLY ${n} entries in img.\n\nImages:\n${JSON.stringify(meta)}\n\nReview the attached ${n} images and return JSON.`;
}

// ---------------------------------------------------------------------------
// Ollama runner
// ---------------------------------------------------------------------------

async function runOllama(
  variant: Variant,
  batch: BatchDetail,
  imagesB64: string[],
): Promise<{ raw: string; thinking: string; tokensIn: number; tokensOut: number }> {
  const userPrompt = buildUserPrompt(batch);
  const body: any = {
    model: variant.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          userPrompt +
          "\n\nThe images follow in order (0 to " +
          (imagesB64.length - 1) +
          ").",
        images: imagesB64,
      },
    ],
    stream: false,
    format: "json",
    options: {
      temperature: variant.temperature,
      num_predict: 16000,
      num_ctx: 32768,
    },
  };

  if (variant.think) {
    body.think = true;
  }

  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000), // 10 min
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Ollama error ${resp.status}: ${err.slice(0, 300)}`);
  }

  const result = (await resp.json()) as any;
  return {
    raw: result.message?.content ?? "",
    thinking: result.message?.thinking ?? "",
    tokensIn: result.prompt_eval_count ?? 0,
    tokensOut: result.eval_count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Gemini (Vertex AI) runner
// ---------------------------------------------------------------------------

async function runGemini(
  variant: Variant,
  batch: BatchDetail,
  imagesB64: string[],
): Promise<{ raw: string; thinking: string; tokensIn: number; tokensOut: number }> {
  const userPrompt = buildUserPrompt(batch);
  const needsGlobal = /gemini-[3-9]/.test(variant.model);
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "tagrdevin",
    location: needsGlobal ? "global" : "europe-west1",
  });

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: SYSTEM_PROMPT + "\n\n" + userPrompt },
  ];
  for (let i = 0; i < imagesB64.length; i++) {
    parts.push({ text: `--- Image ${i}: ${batch.assets[i].filename} ---` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: imagesB64[i] } });
  }
  parts.push({ text: "Now return your JSON assessment for all images above." });

  const config: any = {
    temperature: variant.temperature,
    maxOutputTokens: 65000,
    responseMimeType: "application/json",
  };

  if (variant.thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: variant.thinkingLevel };
  }

  const result = await ai.models.generateContent({
    model: variant.model,
    contents: [{ role: "user", parts }],
    config,
  });

  // Extract thinking from thoughts parts if present
  let thinking = "";
  const candidate = result.candidates?.[0];
  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if ((part as any).thought) {
        thinking += (part as any).text ?? "";
      }
    }
  }

  return {
    raw: result.text ?? "",
    thinking,
    tokensIn: result.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: result.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

function evaluate(
  rawJson: string,
  batch: BatchDetail,
  userDecisions: Map<string, string>,
): Omit<RunResult, "variant" | "batchId" | "elapsed" | "tokensIn" | "tokensOut" | "thinkingChars" | "parseError"> {
  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // Try extracting from markdown code block
    const m = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) parsed = JSON.parse(m[1]);
    else throw new Error("JSON parse failed");
  }

  const imgs: any[] = parsed.img ?? parsed.images ?? [];
  let agree = 0,
    wrongCull = 0,
    wrongKeep = 0,
    total = 0,
    nKeep = 0;
  const details: RunResult["details"] = [];

  for (const img of imgs) {
    if (!Array.isArray(img) || img.length < 2) continue;
    const idx = img[0];
    if (typeof idx !== "number" || idx < 0 || idx >= batch.assets.length) continue;

    // Handle both full format and simple [idx, kc]
    let kc: string;
    if (img.length >= 6) kc = img[5];
    else if (img.length === 2) kc = img[1];
    else kc = img[img.length - 1];

    const llmState = kc === "k" ? "keep" : kc === "c" ? "cull" : null;
    if (!llmState) continue;
    if (llmState === "keep") nKeep++;

    const assetId = batch.assets[idx].id;
    const userState = userDecisions.get(assetId);
    if (!userState) continue;

    total++;
    const match = llmState === userState;
    if (match) {
      agree++;
    } else if (llmState === "cull" && userState === "keep") {
      wrongCull++;
    } else {
      wrongKeep++;
    }

    details.push({
      idx,
      filename: batch.assets[idx].filename,
      llm: llmState,
      user: userState,
      match,
      stars: img.length > 1 ? (img[1] ?? 0) : 0,
      note: img.length > 3 ? (img[3] ?? "") : "",
    });
  }

  const assessed = imgs.filter(
    (img: any) => Array.isArray(img) && typeof img[0] === "number",
  ).length;
  const keepRate = assessed > 0 ? nKeep / assessed : 0;

  return { agree, total, wrongCull, wrongKeep, keepRate, details };
}

// ---------------------------------------------------------------------------
// Batch selection
// ---------------------------------------------------------------------------

async function selectTestBatches(
  userDecisions: Map<string, string>,
  count: number,
): Promise<string[]> {
  console.log("Selecting diverse test batches...");
  const resp = await fetchJson(`${SERVER}/api/batches`);
  const allBatches: Array<{ id: string; hasLlmResult: boolean }> = resp.batches;

  type Scored = {
    id: string;
    n: number;
    decided: number;
    keep: number;
    cull: number;
    mixScore: number;
  };
  const scored: Scored[] = [];

  // Check first 300 batches (they're sorted by date desc)
  for (const b of allBatches.slice(0, 300)) {
    try {
      const detail: BatchDetail = await fetchJson(`${SERVER}/api/batches/${b.id}`, 5000);
      const assets = detail.assets;
      let nKeep = 0,
        nCull = 0;
      for (const a of assets) {
        const d = userDecisions.get(a.id);
        if (d === "keep") nKeep++;
        else if (d === "cull") nCull++;
      }
      const decided = nKeep + nCull;
      if (decided < 5) continue;
      const mixScore =
        Math.max(nKeep, nCull) > 0 ? Math.min(nKeep, nCull) / Math.max(nKeep, nCull) : 0;
      scored.push({ id: b.id, n: assets.length, decided, keep: nKeep, cull: nCull, mixScore });
    } catch {
      /* skip */
    }
  }

  // Sort by: decided count desc, then mix score desc
  scored.sort((a, b) => b.decided - a.decided || b.mixScore - a.mixScore);

  // Pick top N with diverse sizes and mix
  const picked = scored.slice(0, count);
  console.log(`  Found ${scored.length} eligible batches, picked ${picked.length}:`);
  for (const p of picked) {
    console.log(
      `    ${p.id}: ${p.n} photos, ${p.decided} decided (k=${p.keep}/c=${p.cull}, mix=${(p.mixScore * 100).toFixed(0)}%)`,
    );
  }
  return picked.map((p) => p.id);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Thinking & Temperature Experiment ===");
  console.log(`Variants: ${VARIANTS.map((v) => v.name).join(", ")}`);
  console.log();

  // Load user decisions (read-only)
  const db = new Database(DB_PATH, { readonly: true });
  const userDecisions = new Map<string, string>();
  for (const row of db.prepare("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL").all() as any[]) {
    userDecisions.set(row.asset_id, row.state);
  }
  db.close();
  console.log(
    `User decisions: ${userDecisions.size} (keep=${[...userDecisions.values()].filter((v) => v === "keep").length}, cull=${[...userDecisions.values()].filter((v) => v === "cull").length})`,
  );

  // Select test batches
  const batchIds = await selectTestBatches(userDecisions, maxBatches);
  console.log();

  // Cache of images at different resolutions: "batchId:px" → base64[]
  const imageCache = new Map<string, string[]>();

  async function getImages(batch: BatchDetail, px: number): Promise<string[]> {
    const key = `${batch.id}:${px}`;
    if (imageCache.has(key)) return imageCache.get(key)!;
    const images: string[] = [];
    for (const asset of batch.assets) {
      try {
        images.push(await getImageBase64(asset.id, px));
      } catch {
        images.push(""); // placeholder
      }
    }
    imageCache.set(key, images);
    return images;
  }

  const allResults: RunResult[] = [];

  for (const batchId of batchIds) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Batch: ${batchId}`);
    console.log(`${"=".repeat(60)}`);

    const batch: BatchDetail = await fetchJson(`${SERVER}/api/batches/${batchId}`);
    console.log(`  ${batch.assets.length} photos`);

    for (const variant of VARIANTS) {
      process.stdout.write(`  ${variant.name.padEnd(30)} `);

      const images = await getImages(batch, variant.previewPx);
      const t0 = Date.now();

      try {
        const response =
          variant.provider === "ollama"
            ? await runOllama(variant, batch, images)
            : await runGemini(variant, batch, images);

        const elapsed = (Date.now() - t0) / 1000;
        let result: RunResult;

        try {
          const eval_ = evaluate(response.raw, batch, userDecisions);
          result = {
            variant: variant.name,
            batchId,
            elapsed,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            thinkingChars: response.thinking.length,
            parseError: false,
            ...eval_,
          };
        } catch {
          result = {
            variant: variant.name,
            batchId,
            elapsed,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            thinkingChars: response.thinking.length,
            parseError: true,
            agree: 0,
            total: 0,
            wrongCull: 0,
            wrongKeep: 0,
            keepRate: 0,
            details: [],
          };
        }

        allResults.push(result);

        if (result.parseError) {
          console.log(`PARSE ERROR (${elapsed.toFixed(0)}s)`);
        } else {
          const pct = result.total > 0 ? ((result.agree / result.total) * 100).toFixed(0) : "?";
          const wcPct =
            result.total > 0 ? ((result.wrongCull / result.total) * 100).toFixed(0) : "?";
          console.log(
            `${pct}% agree (${result.agree}/${result.total}), ` +
              `wrongCull=${wcPct}%, keepRate=${(result.keepRate * 100).toFixed(0)}%, ` +
              `${elapsed.toFixed(0)}s, ${result.tokensIn}/${result.tokensOut}tok` +
              (result.thinkingChars > 0 ? `, think=${result.thinkingChars}ch` : ""),
          );
        }
      } catch (err) {
        const elapsed = (Date.now() - t0) / 1000;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`ERROR (${elapsed.toFixed(0)}s): ${msg.slice(0, 100)}`);
        allResults.push({
          variant: variant.name,
          batchId,
          elapsed,
          tokensIn: 0,
          tokensOut: 0,
          thinkingChars: 0,
          parseError: true,
          agree: 0,
          total: 0,
          wrongCull: 0,
          wrongKeep: 0,
          keepRate: 0,
          details: [],
        });
      }
    }
  }

  // =========================================================================
  // Aggregate report
  // =========================================================================

  console.log(`\n\n${"=".repeat(78)}`);
  console.log("  AGGREGATE RESULTS");
  console.log(`${"=".repeat(78)}\n`);

  // Group by variant
  const byVariant = new Map<
    string,
    { agree: number; total: number; wrongCull: number; wrongKeep: number; elapsed: number; runs: number; errors: number; tokOut: number; thinkChars: number }
  >();

  for (const r of allResults) {
    const v = byVariant.get(r.variant) ?? {
      agree: 0, total: 0, wrongCull: 0, wrongKeep: 0,
      elapsed: 0, runs: 0, errors: 0, tokOut: 0, thinkChars: 0,
    };
    if (r.parseError) {
      v.errors++;
    } else {
      v.agree += r.agree;
      v.total += r.total;
      v.wrongCull += r.wrongCull;
      v.wrongKeep += r.wrongKeep;
      v.tokOut += r.tokensOut;
      v.thinkChars += r.thinkingChars;
    }
    v.elapsed += r.elapsed;
    v.runs++;
    byVariant.set(r.variant, v);
  }

  const header =
    `${"Variant".padEnd(32)} ${"Agree%".padStart(7)} ${"WCull%".padStart(7)} ` +
    `${"WKeep%".padStart(7)} ${"Photos".padStart(7)} ${"Errs".padStart(5)} ` +
    `${"Time".padStart(7)} ${"TokOut".padStart(8)} ${"Think".padStart(8)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const variant of VARIANTS) {
    const v = byVariant.get(variant.name);
    if (!v) continue;
    const agreePct = v.total > 0 ? ((v.agree / v.total) * 100).toFixed(1) : "  n/a";
    const wcPct = v.total > 0 ? ((v.wrongCull / v.total) * 100).toFixed(1) : "  n/a";
    const wkPct = v.total > 0 ? ((v.wrongKeep / v.total) * 100).toFixed(1) : "  n/a";
    const avgTime = (v.elapsed / v.runs).toFixed(0) + "s";
    const thinkStr = v.thinkChars > 0 ? `${(v.thinkChars / 1000).toFixed(0)}k` : "-";
    console.log(
      `${variant.name.padEnd(32)} ${agreePct.padStart(6)}% ${wcPct.padStart(6)}% ` +
        `${wkPct.padStart(6)}% ${String(v.total).padStart(7)} ${String(v.errors).padStart(5)} ` +
        `${avgTime.padStart(7)} ${String(v.tokOut).padStart(8)} ${thinkStr.padStart(8)}`,
    );
  }

  // Per-batch comparison
  console.log(`\n${"=".repeat(78)}`);
  console.log("  PER-BATCH COMPARISON");
  console.log(`${"=".repeat(78)}\n`);

  for (const batchId of batchIds) {
    const batchResults = allResults.filter((r) => r.batchId === batchId && !r.parseError);
    if (batchResults.length === 0) continue;

    console.log(`--- ${batchId} ---`);
    const best = batchResults.reduce((a, b) =>
      b.total > 0 && (a.total === 0 || b.agree / b.total > a.agree / a.total) ? b : a,
    );
    for (const r of batchResults) {
      const pct = r.total > 0 ? ((r.agree / r.total) * 100).toFixed(0) : "?";
      const marker = r === best ? " <<<" : "";
      console.log(
        `  ${r.variant.padEnd(30)} ${pct}% (${r.agree}/${r.total}) wc=${r.wrongCull} wk=${r.wrongKeep}${marker}`,
      );
    }
    console.log();
  }

  // Worst wrong-culls analysis
  console.log(`${"=".repeat(78)}`);
  console.log("  WRONG-CULL ANALYSIS (most dangerous errors)");
  console.log(`${"=".repeat(78)}\n`);

  for (const variant of VARIANTS) {
    const varResults = allResults.filter((r) => r.variant === variant.name && !r.parseError);
    const wrongCulls = varResults.flatMap((r) =>
      r.details.filter((d) => d.llm === "cull" && d.user === "keep"),
    );
    if (wrongCulls.length === 0) continue;
    console.log(`${variant.name}: ${wrongCulls.length} wrong culls`);
    for (const wc of wrongCulls.slice(0, 5)) {
      console.log(`  [${wc.idx}] ${wc.filename} — stars=${wc.stars} "${wc.note}"`);
    }
    if (wrongCulls.length > 5) console.log(`  ... +${wrongCulls.length - 5} more`);
    console.log();
  }

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `/tmp/thinking-experiment-${timestamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        batchIds,
        variants: VARIANTS.map((v) => ({ ...v })),
        results: allResults.map((r) => ({ ...r, details: r.details })),
      },
      null,
      2,
    ),
  );
  console.log(`\nFull results saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
