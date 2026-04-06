/**
 * LLM client for photo ranking via OpenRouter (Gemini models).
 *
 * Uses OpenRouter's OpenAI-compatible API to access Gemini Flash Lite.
 * Images are sent as base64-encoded data URLs.
 */
import { readFileSync } from "fs";
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.js";
import { DayBatchResponse, ImageAssessment, SimilaritySubgroup } from "./types.js";
import { SessionBatch } from "../batching/session-batcher.js";
import sharp from "sharp";

const CATEGORY_MAP: Record<string, string> = {
  por: "portrait", grp: "group_portrait", sel: "selfie", lan: "landscape",
  tra: "travel", evt: "event", pet: "pet", act: "action", doc: "document",
  rec: "receipt", wb: "whiteboard", ss: "screenshot", snap: "snapchat_save",
  tech: "technical_construction", veh: "vehicle", food: "food", meme: "meme", oth: "other",
  // Also accept full names
  portrait: "portrait", group_portrait: "group_portrait", selfie: "selfie",
  landscape: "landscape", travel: "travel", event: "event", action: "action",
  document: "document", receipt: "receipt", whiteboard: "whiteboard",
  screenshot: "screenshot", snapchat_save: "snapchat_save", snapchat: "snapchat_save",
  technical_construction: "technical_construction", vehicle: "vehicle", other: "other",
};

function expandCategory(code: string): string {
  return CATEGORY_MAP[code] ?? code;
}

function expandCompactResponse(raw: any, batch: SessionBatch): DayBatchResponse {
  const assets = batch.assets;

  const images: ImageAssessment[] = (raw.img ?? raw.images ?? []).map((img: any) => {
    // Support both tuple format [i, stars, "cat", "note", "sg", protect?] and object format
    if (Array.isArray(img)) {
      const [idx, stars, cat, note, sg, protect] = img;
      const asset = assets[idx];
      return {
        imageId: asset?.id ?? `unknown-${idx}`,
        suggestedStars: stars ?? 0,
        categories: (typeof cat === "string" ? [cat] : (cat ?? [])).map(expandCategory),
        protectFromCull: protect ?? false,
        protectionReason: protect ? "personal_memory" : "no_special_protection",
        briefNote: note ?? "",
        similaritySubgroupId: sg ?? null,
      };
    }
    // Object format fallback
    const idx = img.i ?? img.index;
    const asset = assets[idx];
    return {
      imageId: asset?.id ?? `unknown-${idx}`,
      suggestedStars: img.s ?? img.suggestedStars ?? 0,
      categories: (img.c ?? img.categories ?? []).map(expandCategory),
      protectFromCull: img.p ?? img.protectFromCull ?? false,
      protectionReason: img.pr ?? img.protectionReason ?? "no_special_protection",
      briefNote: img.n ?? img.briefNote ?? "",
      similaritySubgroupId: img.g ?? img.similaritySubgroupId ?? null,
    };
  });

  const similaritySubgroups: SimilaritySubgroup[] = (raw.sg ?? raw.similaritySubgroups ?? []).map((sg: any) => {
    const mapIdx = (idx: number) => assets[idx]?.id ?? `unknown-${idx}`;
    const allIds = (sg.all ?? sg.imageIds ?? []).map((v: any) => typeof v === "number" ? mapIdx(v) : v);
    const keepIds = (sg.keep ?? sg.recommendedKeepIds ?? []).map((v: any) => typeof v === "number" ? mapIdx(v) : v);
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
  });

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
  previewMaxPx: 800,
  provider: "openrouter",
};

export class LlmClient {
  private config: LlmClientConfig;

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
    onProgress?: (status: string) => void
  ): Promise<{ response: DayBatchResponse; rawJson: string; inputTokens: number; outputTokens: number }> {
    onProgress?.(`Preparing ${batch.assets.length} images...`);

    // Build image content parts
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];

    for (const asset of batch.assets) {
      const fp = resolveFilePath(asset);
      if (!fp) {
        // Use a placeholder for missing files
        imageParts.push({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }, // tiny placeholder
        });
        continue;
      }

      const buf = await sharp(fp)
        .rotate()
        .resize(this.config.previewMaxPx, this.config.previewMaxPx, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 75 })
        .toBuffer();

      imageParts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
      });
    }

    onProgress?.(`Sending to ${this.config.model} via ${this.config.provider}...`);

    const userPrompt = buildPrompt(batch);
    let rawJson: string;
    let inputTokens: number;
    let outputTokens: number;
    let finishReason: string;

    if (this.config.provider === "vertexai") {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({
        vertexai: true,
        project: this.config.vertexProject ?? "tagrdevin",
        location: this.config.vertexLocation ?? "us-central1",
      });

      const contents = [
        { text: SYSTEM_PROMPT + "\n\n" + userPrompt },
        ...imageParts.map((p) => ({
          inlineData: {
            mimeType: "image/jpeg",
            data: p.image_url.url.replace("data:image/jpeg;base64,", ""),
          },
        })),
      ];

      const result = await ai.models.generateContent({
        model: this.config.model.replace("google/", ""),
        contents,
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
              ...imageParts,
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

      const result = await resp.json() as any;
      rawJson = result.choices?.[0]?.message?.content ?? "";
      inputTokens = result.usage?.prompt_tokens ?? 0;
      outputTokens = result.usage?.completion_tokens ?? 0;
      finishReason = result.choices?.[0]?.finish_reason ?? "unknown";
    }

    onProgress?.(`Parsing response (${inputTokens} in, ${outputTokens} out, finish: ${finishReason})...`);

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
        throw new Error(`Failed to parse LLM response as JSON (saved to ${debugPath}): ${rawJson.slice(0, 200)}`);
      }
    }

    // Map compact format back to full types
    const expanded = expandCompactResponse(parsed, batch);

    return { response: expanded, rawJson, inputTokens, outputTokens };
  }
}
