/**
 * LLM client for photo ranking via OpenRouter (Gemini models).
 *
 * Uses OpenRouter's OpenAI-compatible API to access Gemini Flash Lite.
 * Images are sent as base64-encoded data URLs.
 */
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.js";
import { DayBatchResponse, ImageAssessment, SimilaritySubgroup } from "./types.js";
import { SessionBatch } from "../batching/session-batcher.js";
import sharp from "sharp";

const CATEGORY_MAP: Record<string, string> = {
  por: "portrait",
  grp: "group_portrait",
  sel: "selfie",
  lan: "landscape",
  tra: "travel",
  evt: "event",
  pet: "pet",
  act: "action",
  doc: "document",
  rec: "receipt",
  wb: "whiteboard",
  ss: "screenshot",
  snap: "snapchat_save",
  tech: "technical_construction",
  veh: "vehicle",
  food: "food",
  meme: "meme",
  oth: "other",
  // Also accept full names
  portrait: "portrait",
  group_portrait: "group_portrait",
  selfie: "selfie",
  landscape: "landscape",
  travel: "travel",
  event: "event",
  action: "action",
  document: "document",
  receipt: "receipt",
  whiteboard: "whiteboard",
  screenshot: "screenshot",
  snapchat_save: "snapchat_save",
  snapchat: "snapchat_save",
  technical_construction: "technical_construction",
  vehicle: "vehicle",
  other: "other",
};

function expandCategory(code: string): string {
  return CATEGORY_MAP[code.toLowerCase()] ?? "other";
}

function expandCompactResponse(raw: any, batch: SessionBatch): DayBatchResponse {
  const assets = batch.assets;

  // Deduplicate and validate indices
  const seen = new Set<number>();
  const images: ImageAssessment[] = (raw.img ?? raw.images ?? [])
    .map((img: any) => {
      const idx = Array.isArray(img) ? img[0] : (img.i ?? img.index);

      // Validate index range
      if (typeof idx !== "number" || idx < 0 || idx >= assets.length) {
        console.warn(`LLM: out-of-range index ${idx} (batch size ${assets.length}), skipping`);
        return null;
      }
      // Deduplicate
      if (seen.has(idx)) return null;
      seen.add(idx);

      const asset = assets[idx];

      if (Array.isArray(img)) {
        const [, stars, cat, note, sg, kc] = img;
        const keepCull = kc === "k" ? "keep" : kc === "c" ? "cull" : null;
        return {
          imageId: asset.id,
          suggestedStars: stars ?? 0,
          categories: (typeof cat === "string" ? [cat] : (cat ?? [])).map(expandCategory),
          briefNote: note ?? "",
          similaritySubgroupId: sg ?? null,
          llmKeepCull: keepCull,
        };
      }
      return {
        imageId: asset.id,
        suggestedStars: img.s ?? img.suggestedStars ?? 0,
        categories: (img.c ?? img.categories ?? []).map(expandCategory),
        briefNote: img.n ?? img.briefNote ?? "",
        similaritySubgroupId: img.g ?? img.similaritySubgroupId ?? null,
        llmKeepCull: img.kc === "k" ? "keep" : img.kc === "c" ? "cull" : (img.llmKeepCull ?? null),
      };
    })
    .filter((x: ImageAssessment | null): x is ImageAssessment => x !== null);

  const similaritySubgroups: SimilaritySubgroup[] = (raw.sg ?? raw.similaritySubgroups ?? []).map(
    (sg: any) => {
      const mapIdx = (idx: number) => assets[idx]?.id ?? `unknown-${idx}`;
      const allIds = (sg.all ?? sg.imageIds ?? []).map((v: any) =>
        typeof v === "number" ? mapIdx(v) : v,
      );
      const rawKeepIds = new Set(
        (sg.keep ?? sg.recommendedKeepIds ?? []).map((v: any) =>
          typeof v === "number" ? mapIdx(v) : v,
        ),
      );
      // Guardrail: if LLM keeps too many in a subgroup, enforce ceiling of ceil(N*0.5)
      // Use allIds order (best-first from "all" array) to pick which to keep
      const maxKeep = Math.max(1, Math.ceil(allIds.length * 0.5));
      let keepIds = allIds.filter((id: string) => rawKeepIds.has(id));
      if (keepIds.length > maxKeep && allIds.length >= 3) {
        keepIds = keepIds.slice(0, maxKeep);
      }
      const cullIds = allIds.filter((id: string) => !keepIds.includes(id));
      return {
        subgroupId: sg.id ?? sg.subgroupId ?? "",
        imageIds: allIds,
        subgroupType: (sg.type ?? sg.subgroupType ?? "same_scene").replace("dup", "near_duplicate"),
        recommendedKeepCount: keepIds.length,
        recommendedKeepIds: keepIds,
        cullIds,
        rationale: sg.why ?? sg.rationale ?? "",
        confidence: sg.conf ?? sg.confidence ?? 0.8,
      };
    },
  );

  return {
    batchId: raw.batchId ?? batch.id,
    batchSize: assets.length,
    dateRange: raw.dateRange ?? raw.dr ?? "",
    batchSummary: raw.sum ?? raw.batchSummary ?? "",
    overallConfidence: raw.conf ?? raw.overallConfidence ?? 0.8,
    images,
    similaritySubgroups,
  };
}

export interface LlmClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  previewMaxPx: number;
  provider: "openrouter" | "vertexai";
  vertexProject?: string;
  vertexLocation?: string;
}

export const DEFAULT_LLM_CONFIG: LlmClientConfig = {
  apiKey: "",
  model: "google/gemini-2.5-flash-lite",
  baseUrl: "https://openrouter.ai/api/v1",
  previewMaxPx: 1200, // larger previews for better LLM detail recognition
  provider: "openrouter",
};

export class LlmClient {
  readonly config: LlmClientConfig;

  constructor(config: Partial<LlmClientConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
  }

  /**
   * Rank a day-batch of photos.
   * Resizes images, sends to LLM, parses response.
   */
  async rankBatch(
    batch: SessionBatch,
    resolveFilePath: (asset: { path: string }) => string | null,
    onProgress?: (status: string) => void,
  ): Promise<{
    response: DayBatchResponse;
    rawJson: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    onProgress?.(`Preparing ${batch.assets.length} images...`);

    // Prepare image buffers with index watermarks
    const imageBuffers: Buffer[] = [];
    for (let idx = 0; idx < batch.assets.length; idx++) {
      const asset = batch.assets[idx];
      const fp = resolveFilePath(asset);
      if (!fp) {
        imageBuffers.push(Buffer.from("/9j/4AAQSkZJRg==", "base64")); // tiny placeholder
        continue;
      }
      const svgOverlay = Buffer.from(
        `<svg width="80" height="36"><rect x="0" y="0" width="80" height="36" rx="4" fill="rgba(0,0,0,0.7)"/><text x="40" y="26" font-size="24" font-weight="bold" fill="white" text-anchor="middle" font-family="sans-serif">#${idx}</text></svg>`,
      );
      // eslint-disable-next-line no-await-in-loop -- intentional sequential image processing
      const buf = await sharp(fp)
        .rotate()
        .resize(this.config.previewMaxPx, this.config.previewMaxPx, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .composite([{ input: svgOverlay, gravity: "northwest" }])
        .jpeg({ quality: 75 })
        .toBuffer();
      imageBuffers.push(buf);
    }

    onProgress?.(`Sending to ${this.config.model} via ${this.config.provider}...`);

    const userPrompt = buildPrompt(batch);
    let rawJson: string;
    let inputTokens: number;
    let outputTokens: number;
    let finishReason: string;

    if (this.config.provider === "vertexai") {
      const { GoogleGenAI } = await import("@google/genai");
      // Gemini 3.x+ models require global routing on Vertex AI
      const needsGlobal = /^gemini-[3-9]/.test(this.config.model);
      const ai = new GoogleGenAI({
        vertexai: true,
        project: this.config.vertexProject ?? "tagrdevin",
        location: needsGlobal ? "global" : (this.config.vertexLocation ?? "europe-west1"),
      });

      // Single Content with interleaved text labels + images as parts
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
        { text: SYSTEM_PROMPT + "\n\n" + userPrompt },
      ];
      for (let i = 0; i < imageBuffers.length; i++) {
        const a = batch.assets[i];
        parts.push({
          text: `--- Image ${i}: ${a.filename} (${a.fileCreatedAt.toISOString().slice(11, 19)}) ---`,
        });
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: imageBuffers[i].toString("base64") },
        });
      }
      parts.push({ text: "Now return your JSON assessment for all images above." });

      const result = await ai.models.generateContent({
        model: this.config.model.replace("google/", ""),
        contents: [{ role: "user", parts }],
        config: {
          temperature: 0.2,
          maxOutputTokens: 65000,
          responseMimeType: "application/json",
        },
      });

      rawJson = result.text ?? "";
      inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;
      finishReason = result.candidates?.[0]?.finishReason ?? "unknown";
    } else {
      // OpenRouter path
      const body = {
        model: this.config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              ...imageBuffers.flatMap((buf, i) => [
                { type: "text" as const, text: `--- Image ${i}: ${batch.assets[i].filename} ---` },
                {
                  type: "image_url" as const,
                  image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
                },
              ]),
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 16000,
        temperature: 0.2,
      };

      const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`LLM API error ${resp.status}: ${err.slice(0, 500)}`);
      }

      const result = (await resp.json()) as any;
      rawJson = result.choices?.[0]?.message?.content ?? "";
      inputTokens = result.usage?.prompt_tokens ?? 0;
      outputTokens = result.usage?.completion_tokens ?? 0;
      finishReason = result.choices?.[0]?.finish_reason ?? "unknown";
    }

    onProgress?.(
      `Parsing response (${inputTokens} in, ${outputTokens} out, finish: ${finishReason})...`,
    );

    if (finishReason === "length") {
      console.warn(`WARNING: Response truncated (hit output token limit). Try smaller batch.`);
    }

    // Save raw response for debugging regardless of parse success
    const debugPath = `/tmp/llm-raw-${Date.now()}.txt`;
    const { writeFileSync: debugWrite } = await import("fs");
    debugWrite(debugPath, rawJson);

    // Parse the JSON response
    let parsed: DayBatchResponse;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      // Try to extract JSON from markdown code blocks
      const match = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        parsed = JSON.parse(match[1]);
      } else {
        throw new Error(
          `Failed to parse LLM response as JSON (saved to ${debugPath}): ${rawJson.slice(0, 200)}`,
        );
      }
    }

    const expanded = expandCompactResponse(parsed, batch);
    if (expanded.images.length !== batch.assets.length) {
      console.warn(
        `LLM returned ${expanded.images.length} valid images, expected ${batch.assets.length}`,
      );
    }

    return { response: expanded, rawJson, inputTokens, outputTokens };
  }
}
