#!/usr/bin/env npx tsx
/**
 * Prompt v3 experiment: burst-only prompts without a rigid count default.
 *
 * v2's dominant failure mode was rigid "keep 2" — user keep count varies 0-4
 * but v2 almost always returns exactly 2. v3 tries three prompt shapes that
 * let the model pick an adaptive count (0/1/2/3+) based on what it sees.
 *
 * Variants tested (--prompt flag):
 *   - min        : 4-line terse
 *   - adaptive   : ~18-line decision-tree
 *   - priorities : ~28-line detailed priorities + adaptive count
 *
 * Models tested (--models flag, comma-separated):
 *   - qwen_terse   : qwen3.6:35b-a3b, think=false, local
 *   - qwen_think   : qwen3.6:35b-a3b, think=true, local (slow)
 *   - gemma4_31b   : gemma4:31b, local
 *   - gemma4_e4b   : gemma4:e4b, local (fast)
 *   - 31flashlite  : gemini-3.1-flash-lite-preview, cloud
 *
 * Reuses the 30 groups from Stage A for apples-to-apples comparison with v2.
 *
 * Output: data/experiments/2026-04-20-promptv3-<prompt>.json
 */

import { GoogleGenAI } from "@google/genai";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readFileSync } from "fs";
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
const promptKind = getArg("--prompt", "adaptive"); // min | adaptive | priorities
const modelsCsv = getArg(
  "--models",
  "qwen_terse,gemma4_31b,gemma4_e4b,31flashlite",
);
const sourceExp = resolve(
  __dirname,
  "../data/experiments/2026-04-19-stageA.json",
);
const outPath = resolve(
  __dirname,
  `../data/experiments/2026-04-20-promptv3-${promptKind}.json`,
);

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------

const PROMPT_MIN = `Pick the photo(s) worth keeping from this burst of similar shots.

Return JSON: {"best": [indices], "reason": "brief why", "ranking": [best_to_worst]}.
Indices 0-based. If every frame fails (blur, closed eyes), return "best": [].`;

const PROMPT_ADAPTIVE = `You judge which photos to keep from a burst of very similar family photos.

Look at the frames and decide a COUNT first:
- Nearly identical shutter-bursts → keep 1
- Two genuinely different expressions or moments → keep 2
- Action sequence with distinct stages → keep 3 or more
- All frames fail (blurry, closed eyes, bad composition) → keep 0

Within the count you chose, rank by: (1) sharpness/focus, (2) faces & expressions, (3) composition, (4) moment.
These are family memories — when torn, prefer keeping over losing a real moment.

Return JSON: {"best": [indices], "reason": "brief why", "ranking": [best_to_worst]}
Indices 0-based.`;

const PROMPT_PRIORITIES = `You are a photo quality judge for a family photo burst.

PRIORITIES (in order of importance):
1. People & faces — if visible, who has the best expression (eyes open, clear face, natural)? A frame that shows a face missing or obscured in other frames is valuable.
2. Sharpness & focus — subject in focus. Motion-blurred faces or missed-focus = strong cull signal.
3. Expression & moment — natural over forced, peak-action over mid-transition.
4. Composition & framing — balanced, no awkward crops of heads/limbs.
5. Exposure — well-lit, not blown-out or crushed.

KEEP COUNT — choose adaptively based on what the frames show:
- Near-identical shutter-bursts (virtually the same pose, expression, framing) → keep 1.
- Two frames capture genuinely distinct moments / expressions / stages → keep 2.
- An action sequence (running, playing) with 3+ distinct stages → keep 3 or more.
- Every frame fails (all blurry / all eyes-closed / all missed-focus) → keep 0.

When torn between two equally-good candidates for an extra keeper, prefer the one whose faces/subjects differ from the first keeper — face coverage matters.

These are family memories. When in doubt, keep more rather than less; the user trims later.

Return JSON: {"best": [indices], "reason": "brief why", "ranking": [best_to_worst_indices]}
Indices 0-based matching image order shown.`;

const PROMPTS: Record<string, string> = {
  min: PROMPT_MIN,
  adaptive: PROMPT_ADAPTIVE,
  priorities: PROMPT_PRIORITIES,
};

const PROMPT = PROMPTS[promptKind];
if (!PROMPT) {
  console.error(`Unknown prompt: ${promptKind}. Use: min | adaptive | priorities`);
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Variants
// ----------------------------------------------------------------------------

type ModelSpec = {
  name: string;
  provider: "ollama" | "vertexai";
  model: string;
  think?: boolean;
  numPredict?: number;
};

const ALL_MODELS: Record<string, ModelSpec> = {
  qwen_terse: {
    name: `qwen36_a3b_terse_v3_${promptKind}`,
    provider: "ollama",
    model: "qwen3.6:35b-a3b",
    think: false,
  },
  qwen_think: {
    name: `qwen36_a3b_think_v3_${promptKind}`,
    provider: "ollama",
    model: "qwen3.6:35b-a3b",
    think: true,
    numPredict: 4000,
  },
  gemma4_31b: {
    name: `gemma4_31b_v3_${promptKind}`,
    provider: "ollama",
    model: "gemma4:31b",
  },
  gemma4_e4b: {
    name: `gemma4_e4b_v3_${promptKind}`,
    provider: "ollama",
    model: "gemma4:e4b",
  },
  "31flashlite": {
    name: `31flashlite_v3_${promptKind}`,
    provider: "vertexai",
    model: "gemini-3.1-flash-lite-preview",
  },
};

const VARIANTS: ModelSpec[] = modelsCsv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((k) => {
    const v = ALL_MODELS[k];
    if (!v) {
      console.error(`Unknown model key: ${k}. Known: ${Object.keys(ALL_MODELS).join(",")}`);
      process.exit(1);
    }
    return v;
  });

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function getImageBase64(assetId: string): Promise<string> {
  // Retry on transient failures (server restart, brief network blip).
  // Empty-string fallback would feed garbage to the LLM — much better to wait.
  let lastErr: unknown = null;
  for (const delay of [0, 1000, 3000, 7000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const resp = await fetch(
        `${server}/api/preview?id=${encodeURIComponent(assetId)}&size=preview`,
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

async function runOllama(
  variant: ModelSpec,
  ids: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const userPrompt =
    `${ids.length} photos from a burst. Pick the best.\n\n` +
    ids.map((_id, i) => `Image ${i}`).join("\n");
  const body: Record<string, unknown> = {
    model: variant.model,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: userPrompt, images: imagesB64 },
    ],
    stream: true,
    format: "json",
    keep_alive: "30m",
    options: { temperature: 0, num_predict: variant.numPredict ?? 2000, num_ctx: 32768 },
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
      } catch { /* partial line */ }
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
    { text: PROMPT + `\n\n${imagesB64.length} photos from a burst.\n` },
  ];
  for (let i = 0; i < imagesB64.length; i++) {
    parts.push({ text: `--- Image ${i} ---` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: imagesB64[i] } });
  }
  parts.push({ text: "Return your JSON verdict." });
  const result = await ai.models.generateContent({
    model: variant.model,
    contents: [{ role: "user", parts }],
    config: {
      temperature: 0,
      maxOutputTokens: 2000,
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
): { best: number[]; ranking: number[]; reason: string } {
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
  const best = Array.isArray(parsed.best)
    ? (parsed.best as unknown[]).filter(
        (i): i is number => typeof i === "number" && i >= 0 && i < n,
      )
    : [];
  const ranking = Array.isArray(parsed.ranking)
    ? (parsed.ranking as unknown[]).filter(
        (i): i is number => typeof i === "number" && i >= 0 && i < n,
      )
    : [];
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { best, ranking, reason };
}

// ----------------------------------------------------------------------------
// Resume support — skip groups/variants already in outPath
// ----------------------------------------------------------------------------

type ExistingResult = {
  group: { batchId: string; subgroupId: string };
  variants: Array<{ variant: string; bestPicks: number[] }>;
};

function loadExisting(): ExistingResult[] {
  try {
    const data = JSON.parse(readFileSync(outPath, "utf-8"));
    return (data.results ?? []) as ExistingResult[];
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  console.log("=== Prompt v3 experiment ===");
  console.log(`Prompt: ${promptKind}`);
  console.log(`Variants: ${VARIANTS.map((v) => v.name).join(", ")}`);
  console.log(`Output: ${outPath}\n`);

  const stageA = JSON.parse(readFileSync(sourceExp, "utf-8"));
  const groups = stageA.results.map((r: Record<string, unknown>) => r.group) as Array<{
    batchId: string;
    subgroupId: string;
    type: string;
    assetIds: string[];
    filenames: string[];
    llmKeepIds: string[];
    llmRanking?: string[];
    userKeepIds: string[];
    userCullIds: string[];
  }>;
  console.log(`Reusing ${groups.length} groups from Stage A`);

  const existing = loadExisting();
  const existingByGroup = new Map<string, ExistingResult>();
  for (const e of existing) {
    existingByGroup.set(`${e.group.batchId}::${e.group.subgroupId}`, e);
  }
  console.log(`Existing completed groups: ${existing.length}\n`);

  const allResults: Array<Record<string, unknown>> = [];

  for (const group of groups) {
    const gkey = `${group.batchId}::${group.subgroupId}`;
    const prior = existingByGroup.get(gkey);
    const priorVariants = new Map<string, any>();
    if (prior) {
      for (const v of prior.variants as any[]) priorVariants.set(v.variant, v);
    }

    const needed = VARIANTS.filter((v) => !priorVariants.has(v.name));
    if (needed.length === 0) {
      console.log(`\n[SKIP] ${gkey} — all variants complete`);
      allResults.push(prior!);
      continue;
    }

    console.log(
      `\n--- ${gkey}: ${group.assetIds.length} photos (${group.type}) ---`,
    );
    console.log(
      `  User keeps: ${group.userKeepIds.map((id) => group.assetIds.indexOf(id)).join(",")}`,
    );

    const imagesB64: string[] = [];
    for (const id of group.assetIds) {
      try {
        imagesB64.push(await getImageBase64(id));
      } catch {
        imagesB64.push("");
      }
    }

    const variantResults: Array<Record<string, unknown>> = [];
    // Preserve any completed variants for this group
    for (const v of priorVariants.values()) variantResults.push(v);

    for (const variant of needed) {
      const t0 = Date.now();
      let raw: string, tokensIn = 0, tokensOut = 0;
      try {
        const r =
          variant.provider === "ollama"
            ? await runOllama(variant, group.assetIds, imagesB64)
            : await runGemini(variant, group.assetIds, imagesB64);
        raw = r.raw;
        tokensIn = r.tokensIn;
        tokensOut = r.tokensOut;
      } catch (err: unknown) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120);
        console.log(`  ${variant.name}: ERROR — ${msg}`);
        variantResults.push({
          variant: variant.name,
          bestPicks: [],
          ranking: [],
          reason: `ERROR: ${msg}`,
          elapsed: (Date.now() - t0) / 1000,
          matchesUser: null,
          matchesLlm: false,
          tokensIn: 0,
          tokensOut: 0,
        });
        continue;
      }

      const elapsed = (Date.now() - t0) / 1000;
      let best: number[] = [], ranking: number[] = [], reason = "";
      try {
        const p = parseResponse(raw, group.assetIds.length);
        best = p.best;
        ranking = p.ranking;
        reason = p.reason;
      } catch {
        console.log(`  ${variant.name}: PARSE ERROR (${elapsed.toFixed(1)}s)`);
        variantResults.push({
          variant: variant.name,
          bestPicks: [],
          ranking: [],
          reason: `PARSE ERROR: ${raw.slice(0, 120)}`,
          elapsed,
          matchesUser: null,
          matchesLlm: false,
          tokensIn,
          tokensOut,
        });
        continue;
      }

      const pickedIds = best.map((i) => group.assetIds[i]);
      const matchesUser =
        group.userKeepIds.length > 0
          ? pickedIds.some((id) => group.userKeepIds.includes(id))
          : null;
      const matchesLlm = pickedIds.some((id) => group.llmKeepIds.includes(id));

      const userMark = matchesUser === true ? "✓" : matchesUser === false ? "✗" : "?";
      const llmMark = matchesLlm ? "=LLM" : "≠LLM";
      console.log(
        `  ${variant.name}: pick=${best.join(",")} ${userMark} ${llmMark} (${elapsed.toFixed(1)}s) — ${reason.slice(0, 60)}`,
      );

      variantResults.push({
        variant: variant.name,
        bestPicks: best,
        ranking,
        reason,
        elapsed,
        matchesUser,
        matchesLlm,
        tokensIn,
        tokensOut,
      });

      // Snapshot after each model completion so we can resume cleanly
      const snapshot = {
        timestamp: new Date().toISOString(),
        completedGroups: allResults.length + 1,
        targetGroups: groups.length,
        variants: VARIANTS.map((v) => v.name),
        promptKind,
        prompt: PROMPT,
        results: [...allResults, { group, variants: variantResults }],
      };
      writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    }

    allResults.push({ group, variants: variantResults });
  }

  console.log("\n=== DONE ===");
  console.log(`Results: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
