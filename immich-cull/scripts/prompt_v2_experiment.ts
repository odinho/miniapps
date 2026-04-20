#!/usr/bin/env npx tsx
/**
 * Prompt v2 experiment: test a "keep 2 by default" prompt against the current v1
 * prompt on the same 30 groups that were used in the overnight experiment.
 *
 * Key hypothesis (from graded data): the prod prompt tells models to "keep up to 2
 * if genuinely different", and they parse it too strictly — user keeps ~2.07/group,
 * models keep ~1.0-1.2. Flipping the default to "keep 2, only 1 if near-identical"
 * should close the keep-bias gap.
 *
 * Runs only two variants to keep overnight cost bounded:
 *   - qwen36_a3b_terse (fast, 60s/group) — the leading local candidate
 *   - gemini-3.1-flash-lite (fast, 4s/group) — current prod
 *
 * Output: JSON in data/experiments/ with the same shape as the main experiment.
 */

import { GoogleGenAI } from "@google/genai";
import Database from "better-sqlite3";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readFileSync, existsSync } from "fs";
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
const SOURCE_EXP = resolve(
  __dirname,
  process.argv.includes("--only-gemma31b")
    ? "../data/experiments/2026-04-19-stageB4.json"
    : "../data/experiments/2026-04-19-stageA.json",
);
const OUT_PATH = resolve(
  __dirname,
  process.argv.includes("--only-gemma31b")
    ? "../data/experiments/2026-04-20-promptv2-gemma31b.json"
    : "../data/experiments/2026-04-20-promptv2.json",
);

// --- Prompt v2 ---
// Based on graded-data finding: user keeps ~2 per group, all tested models keep ~1.
// Every keep-bias grade was "too few" or "right" — zero "too many". So bias the
// model toward more, and give explicit priorities drawn from user's notes.
const BURST_PROMPT_V2 = `You are a photo quality judge for a family photo burst.

PICK POLICY:
- Default: keep 2 photos that best complement each other.
- Keep only 1 if all images are near-identical shutter-bursts (virtually the same frame).
- Keep 3+ if moments are genuinely distinct (different action stages, different subjects shown).

PRIORITIES (in order):
1. PEOPLE COVERAGE — if keeping 2, choose frames that together show the most faces / expressions. A second keeper that captures a face missing from the first is almost always worth it.
2. SHARPNESS & EXPRESSION — subject in focus, eyes open, no blur.
3. COMPOSITION — balanced framing, no awkward crops.
4. MOMENT — peak action, interesting instant.

These are family memories. When in doubt, keep more rather than less — the user trims later.

Return JSON:
{"best": [indices], "reason": "why this combination", "ranking": [best_to_worst_indices]}
Indices are 0-based matching image order shown.`;

interface Variant {
  name: string;
  provider: "ollama" | "vertexai";
  model: string;
}

const onlyGemma = process.argv.includes("--only-gemma31b");

const VARIANTS: Variant[] = onlyGemma
  ? [{ name: "gemma4_31b_v2", provider: "ollama", model: "gemma4:31b" }]
  : [
      { name: "qwen36_a3b_terse_v2", provider: "ollama", model: "qwen3.6:35b-a3b" },
      {
        name: "31flashlite_v2",
        provider: "vertexai",
        model: "gemini-3.1-flash-lite-preview",
      },
    ];

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return resp.json();
}

async function getImageBase64(assetId: string): Promise<string> {
  const resp = await fetch(
    `${server}/api/preview?id=${encodeURIComponent(assetId)}&size=preview`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!resp.ok) throw new Error(`preview ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

async function runOllama(
  variant: Variant,
  ids: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const userPrompt =
    `${ids.length} photos from a burst. Pick the best combination.\n\n` +
    ids.map((_id, i) => `Image ${i}`).join("\n");
  const body: Record<string, unknown> = {
    model: variant.model,
    messages: [
      { role: "system", content: BURST_PROMPT_V2 },
      { role: "user", content: userPrompt, images: imagesB64 },
    ],
    stream: true,
    format: "json",
    keep_alive: "30m",
    think: false,
    options: { temperature: 0, num_predict: 2000, num_ctx: 32768 },
  };

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
  variant: Variant,
  _ids: string[],
  imagesB64: string[],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: "tagrdevin",
    location: "global",
  });
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: BURST_PROMPT_V2 + `\n\n${imagesB64.length} photos from a burst.\n` },
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

async function main() {
  console.log("=== Prompt v2 experiment ===");
  console.log(`Variants: ${VARIANTS.map((v) => v.name).join(", ")}`);

  // Reuse the same 30 groups that were in stage A
  const stageA = JSON.parse(readFileSync(SOURCE_EXP, "utf-8"));
  const groups = stageA.results.map((r: Record<string, unknown>) => r.group);
  console.log(`Reusing ${groups.length} groups from Stage A`);

  const allResults: Array<Record<string, unknown>> = [];

  for (const group of groups as Array<{
    batchId: string;
    subgroupId: string;
    type: string;
    assetIds: string[];
    filenames: string[];
    llmKeepIds: string[];
    userKeepIds: string[];
  }>) {
    console.log(
      `\n--- ${group.batchId} / ${group.subgroupId}: ${group.assetIds.length} photos (${group.type}) ---`,
    );
    console.log(
      `  Stage A LLM keeps: ${group.llmKeepIds.map((id) => group.assetIds.indexOf(id)).join(",")}`,
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
    for (const variant of VARIANTS) {
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
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 100);
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
          reason: `PARSE ERROR: ${raw.slice(0, 100)}`,
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
    }

    allResults.push({ group, variants: variantResults });

    // Write snapshot after each group
    writeFileSync(
      OUT_PATH,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          completedGroups: allResults.length,
          targetGroups: groups.length,
          variants: VARIANTS.map((v) => v.name),
          promptVersion: "v2-keep-more",
          prompt: BURST_PROMPT_V2,
          results: allResults,
        },
        null,
        2,
      ),
    );
  }

  console.log("\n=== DONE ===");
  console.log(`Results: ${OUT_PATH}`);
}

main();
