#!/usr/bin/env npx tsx
/**
 * Face-coverage experiment: augment the burst-pick prompt with Immich's
 * ML-identified people per photo. Test whether giving the LLM explicit
 * face metadata improves pick quality — especially on groups where the
 * user's free-text notes said "missing the grandparents", "Halldis face
 * is actually in no 4 too", etc.
 *
 * Hypothesis: face coverage is the single clearest pattern in user notes,
 * and Immich already has identified people per asset. Telling the LLM
 * "Image 0: faces=[Skjalg], Image 1: faces=[Skjalg, Halldis]" lets it
 * reason about coverage directly rather than guessing from pixels.
 *
 * Scope: same 30 groups from Stage A; only qwen_terse variant; terse
 * keep-more prompt (v2-style) with face metadata appended.
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { Agent, setGlobalDispatcher } from "undici";
import { config as loadEnv } from "dotenv";

loadEnv();
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMMICH_URL = (process.env.IMMICH_URL ?? "").replace(/\/$/, "");
const IMMICH_KEY = process.env.IMMICH_API_KEY ?? "";
const server = "http://localhost:3737";
const OLLAMA_URL = "http://localhost:11434";
const SOURCE_EXP = resolve(
  __dirname,
  "../data/experiments/2026-04-19-stageA.json",
);
const OUT_PATH = resolve(
  __dirname,
  "../data/experiments/2026-04-20-face-coverage.json",
);

const BURST_PROMPT_FACE = `You are a photo quality judge for a family photo burst.

PICK POLICY:
- Default: keep 2 photos that together cover the most distinct people.
- Keep only 1 if photos are near-identical shutter-bursts (same faces, same moment).
- Keep 3+ if keeping covers a person the other keepers miss, or moments are genuinely distinct.

PRIORITIES (in order):
1. PEOPLE COVERAGE — this is the biggest single factor. The face metadata below tells you which named people appear in each image. Bias your picks to cover as many distinct people as possible across your keepers. A 2nd keeper that introduces a new face is almost always worth it.
2. SHARPNESS & EXPRESSION — subject in focus, eyes open, no blur.
3. COMPOSITION — balanced framing, no awkward crops.
4. MOMENT — peak action, interesting instant.

These are family memories. When in doubt, keep more rather than less.

Return JSON:
{"best": [indices], "reason": "why this combination, naming the people covered", "ranking": [best_to_worst_indices]}`;

async function fetchPeopleForAsset(assetId: string): Promise<string[]> {
  const r = await fetch(`${IMMICH_URL}/api/assets/${assetId}`, {
    headers: { "x-api-key": IMMICH_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { people?: Array<{ name?: string }> };
  return (j.people ?? [])
    .map((p) => p.name?.trim() ?? "")
    .filter((n) => n.length > 0);
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
  assetIds: string[],
  imagesB64: string[],
  people: string[][],
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const peopleLines = people
    .map((p, i) => `Image ${i}: faces=[${p.length ? p.join(", ") : "(none)"}]`)
    .join("\n");
  const userPrompt =
    `${assetIds.length} photos from a burst.\n\nFACE METADATA (ML-identified named people):\n${peopleLines}\n\nPick the best combination.`;
  const body: Record<string, unknown> = {
    model: "qwen3.6:35b-a3b",
    messages: [
      { role: "system", content: BURST_PROMPT_FACE },
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
      } catch { /* partial */ }
    }
  }
  return { raw: content, tokensIn: promptEvalCount, tokensOut: evalCount };
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
  console.log("=== Face-coverage experiment ===");

  const stageA = JSON.parse(readFileSync(SOURCE_EXP, "utf-8"));
  const groups = stageA.results.map((r: Record<string, unknown>) => r.group);
  console.log(`Reusing ${groups.length} groups from Stage A`);

  const results: Array<Record<string, unknown>> = [];

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
    const people: string[][] = [];
    for (const id of group.assetIds) {
      try {
        people.push(await fetchPeopleForAsset(id));
      } catch {
        people.push([]);
      }
    }
    console.log(
      `  faces: ${people.map((p, i) => `[${i}:${p.length ? p.join(",") : "-"}]`).join(" ")}`,
    );

    const imagesB64: string[] = [];
    for (const id of group.assetIds) {
      try {
        imagesB64.push(await getImageBase64(id));
      } catch {
        imagesB64.push("");
      }
    }

    const t0 = Date.now();
    let best: number[] = [], ranking: number[] = [], reason = "";
    try {
      const r = await runOllama(group.assetIds, imagesB64, people);
      const p = parseResponse(r.raw, group.assetIds.length);
      best = p.best;
      ranking = p.ranking;
      reason = p.reason;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR: ${msg}`);
    }
    const elapsed = (Date.now() - t0) / 1000;

    const pickedIds = best.map((i) => group.assetIds[i]);
    const matchesUser =
      group.userKeepIds.length > 0
        ? pickedIds.some((id) => group.userKeepIds.includes(id))
        : null;
    const matchesLlm = pickedIds.some((id) => group.llmKeepIds.includes(id));
    const distinctFaces = new Set<string>();
    for (const i of best) for (const p of people[i] ?? []) distinctFaces.add(p);
    const totalFaces = new Set<string>();
    for (const ps of people) for (const p of ps) totalFaces.add(p);

    console.log(
      `  pick=${best.join(",")} ${matchesUser ? "✓" : "✗"} faces=${[...distinctFaces].join(",")}/${totalFaces.size} (${elapsed.toFixed(1)}s)`,
    );

    results.push({
      group,
      people,
      pick: { best, ranking, reason },
      matchesUser,
      matchesLlm,
      distinctFacesCovered: [...distinctFaces],
      totalFacesInGroup: [...totalFaces],
      coverageRatio:
        totalFaces.size > 0 ? distinctFaces.size / totalFaces.size : null,
      elapsed,
    });

    writeFileSync(
      OUT_PATH,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          completedGroups: results.length,
          targetGroups: groups.length,
          variant: "qwen36_a3b_terse_face",
          prompt: BURST_PROMPT_FACE,
          results,
        },
        null,
        2,
      ),
    );
  }

  console.log("\n=== DONE ===");
}

main();
