/** Provider SDK adapters. Selection and fallback live only in aiProviderWaterfall.ts. */
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { isStructuredAiError } from "../errors.js";
import {
  AiProviderFailure,
  isRetryableAiProviderFailure,
  runAiProviderWaterfall,
  type AiProviderContext,
  type AiProviderCredentials,
} from "./aiProviderWaterfall.js";

/**
 * Model defaults are read lazily (at call time) so operators can tune them
 * via env without a restart and tests can override them after import.
 *
 * Free-tier strategy:
 * - Gemini defaults to `gemini-2.5-flash` (the current best free-tier model
 *   for JSON extraction AND vision/OCR; gemini-1.5-flash is deprecated).
 * - OpenRouter defaults to a free `:free` model, so a missing OpenAI quota
 *   falls through to a zero-cost provider before touching Gemini.
 */
const BACKOFF_MS = [500, 1_000, 2_000];
const DEFAULT_TIMEOUT_MS = 45_000;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const openaiModel = () => process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const openaiVisionModel = () =>
  process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
const geminiModel = () => process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
/** The Gemini fallback slot can use a cheaper/different model (e.g. flash-lite). */
const geminiFallbackModel = () =>
  process.env.GEMINI_FALLBACK_MODEL ?? geminiModel();
/**
 * The previous default, `deepseek/deepseek-chat-v3-0324:free`, has been retired
 * by OpenRouter and is no longer in its model list. Requests for it returned
 * 404 — neither retryable nor a credential failure — which aborted the whole
 * waterfall before Gemini was ever reached. Every AI call in the product
 * silently fell back to regex heuristics, and /ask, which has no fallback,
 * failed outright.
 *
 * Free slugs get retired regularly, so the guard in the waterfall matters more
 * than this value: a dead model should cost that one provider, not all of them.
 */
const openrouterModel = () =>
  process.env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free";

/** Per-provider request timeout. `AI_TIMEOUT_MS` overrides the default. */
function providerTimeoutMs(): number {
  const parsed = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);
const VISION_INSTRUCTION =
  "Transcribe all text in this image exactly as it appears, preserving line breaks. " +
  "Output only the transcribed text, no commentary.";

function providerCredentials(): AiProviderCredentials {
  return {
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    geminiPrimary: process.env.GEMINI_API_KEY_PRIMARY,
    geminiFallback: process.env.GEMINI_API_KEY_FALLBACK,
  };
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AiProviderFailure("timeout")),
      providerTimeoutMs(),
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = BACKOFF_MS.length,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableAiProviderFailure(error) || attempt >= maxRetries) {
        throw error;
      }
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
    }
  }
}

function stripCodeFence(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1]! : trimmed;
}

/**
 * Free/open models often wrap JSON in prose or multiple braces. If a direct
 * parse fails, extract the first balanced JSON object/array and parse that,
 * so a stray preamble doesn't waste a provider call.
 */
function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim();
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  const open = trimmed[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonLoose(raw: string): unknown {
  const stripped = stripCodeFence(raw);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const block = extractJsonBlock(stripped);
    if (block === null) {
      if (error instanceof Error) throw error;
      throw new SyntaxError("Could not parse model JSON output");
    }
    return JSON.parse(block);
  }
}

async function providerText(
  operation: (context: AiProviderContext) => Promise<string>,
  credentials: AiProviderCredentials = providerCredentials(),
) {
  const result = await runAiProviderWaterfall(operation, credentials);
  if (isStructuredAiError(result)) throw result;
  return result;
}

export interface JsonCallOptions {
  system: string;
  user: string;
  schemaHint?: string;
  /** OpenAI (or OpenAI-compatible) model override. */
  model?: string;
  /** OpenRouter model override (e.g. a specific `:free` slug). */
  openrouterModel?: string;
  maxRetries?: number;
}

async function openaiJson(
  apiKey: string,
  system: string,
  user: string,
  model: string,
  maxRetries?: number,
) {
  const client = new OpenAI({ apiKey });
  return withRetry(async () => {
    const response = await withTimeout(
      client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    );
    const content = response.choices[0]?.message?.content;
    if (!content) throw new AiProviderFailure("parsing");
    return content;
  }, maxRetries);
}

/**
 * OpenRouter exposes an OpenAI-compatible API. We deliberately do NOT send
 * `response_format: { type: "json_object" }`: support varies across the free
 * `:free` models, and the schema hint in the system prompt plus lenient
 * parsing below handles output shaping without depending on the provider.
 */
async function openrouterJson(
  apiKey: string,
  system: string,
  user: string,
  model: string,
  maxRetries?: number,
) {
  const client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  return withRetry(async () => {
    const response = await withTimeout(
      client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    );
    const content = response.choices[0]?.message?.content;
    if (!content) throw new AiProviderFailure("parsing");
    return content;
  }, maxRetries);
}

async function geminiJson(
  apiKey: string,
  system: string,
  user: string,
  maxRetries?: number,
  modelName?: string,
) {
  const client = new GoogleGenerativeAI(apiKey);
  return withRetry(async () => {
    const model = client.getGenerativeModel({
      model: modelName ?? geminiModel(),
      systemInstruction: system,
      generationConfig: { responseMimeType: "application/json" },
    });
    const text = (
      await withTimeout(model.generateContent(user))
    ).response.text();
    if (!text) throw new AiProviderFailure("parsing");
    return text;
  }, maxRetries);
}

export async function callJson<T = unknown>(options: JsonCallOptions) {
  // `openrouterModel` is renamed on destructure: an unrenamed binding would
  // shadow the module-level `openrouterModel()` default resolver below.
  const {
    system,
    user,
    schemaHint,
    model,
    openrouterModel: openrouterModelOverride,
    maxRetries,
  } = options;
  const fullSystem = schemaHint
    ? `${system}\n\nRespond ONLY with JSON matching:\n${schemaHint}`
    : system;

  const raw = await providerText(({ family, apiKey, slot }) =>
    family === "openai"
      ? openaiJson(apiKey, fullSystem, user, model ?? openaiModel(), maxRetries)
      : family === "openrouter"
        ? openrouterJson(
            apiKey,
            fullSystem,
            user,
            openrouterModelOverride ?? openrouterModel(),
            maxRetries,
          )
        : geminiJson(
            apiKey,
            fullSystem,
            user,
            maxRetries,
            slot === "gemini_fallback" ? geminiFallbackModel() : undefined,
          ),
  );

  // Parsing happens after provider selection so programming/schema bugs never
  // trigger a request to another provider.
  return parseJsonLoose(raw) as T;
}

async function openaiVision(apiKey: string, buffer: Buffer, mimeType: string) {
  const client = new OpenAI({ apiKey });
  return withRetry(async () => {
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const response = await withTimeout(
      client.chat.completions.create({
        model: openaiVisionModel(),
        messages: [
          { role: "system", content: VISION_INSTRUCTION },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: dataUrl } }],
          },
        ],
      }),
    );
    const content = response.choices[0]?.message?.content;
    if (!content) throw new AiProviderFailure("parsing");
    return content;
  });
}

async function geminiVision(
  apiKey: string,
  buffer: Buffer,
  mimeType: string,
  modelName?: string,
) {
  const client = new GoogleGenerativeAI(apiKey);
  return withRetry(async () => {
    const model = client.getGenerativeModel({ model: modelName ?? geminiModel() });
    const text = (
      await withTimeout(
        model.generateContent([
          VISION_INSTRUCTION,
          { inlineData: { mimeType, data: buffer.toString("base64") } },
        ]),
      )
    ).response.text();
    if (!text) throw new AiProviderFailure("parsing");
    return text;
  });
}

export async function visionTranscribe(buffer: Buffer, mimeType: string) {
  if (!IMAGE_MIME_TYPES.has(mimeType)) {
    throw new AiProviderFailure("validation", "Unsupported image type");
  }

  // Vision stays on OpenAI -> Gemini only: the default free OpenRouter models
  // are text-only, and Gemini's vision is free-tier friendly, so there is no
  // reason to burn an OpenRouter attempt on an image payload.
  const visionCredentials: AiProviderCredentials = providerCredentials();
  delete visionCredentials.openrouter;

  return providerText(
    ({ family, apiKey, slot }) =>
      family === "openai"
        ? openaiVision(apiKey, buffer, mimeType)
        : geminiVision(
            apiKey,
            buffer,
            mimeType,
            slot === "gemini_fallback" ? geminiFallbackModel() : undefined,
          ),
    visionCredentials,
  );
}
