import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderCooldowns } from "../../src/integrations/aiProviderWaterfall.js";

const { openaiCreateMock, geminiGenerateContentMock, geminiModels } =
  vi.hoisted(() => ({
    openaiCreateMock: vi.fn(),
    geminiGenerateContentMock: vi.fn(),
    geminiModels: [] as string[],
  }));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: openaiCreateMock } };
  }
  return { default: OpenAI };
});

vi.mock("@google/generative-ai", () => {
  class GoogleGenerativeAI {
    getGenerativeModel({ model }: { model: string }) {
      geminiModels.push(model);
      return { generateContent: geminiGenerateContentMock };
    }
  }
  return { GoogleGenerativeAI };
});

import { callJson, visionTranscribe } from "../../src/integrations/openai.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY_PRIMARY",
  "GEMINI_API_KEY_FALLBACK",
  "AI_TIMEOUT_MS",
  "OPENROUTER_MODEL",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODEL",
  "OPENAI_MODEL",
] as const;

const providerError = (status: number) =>
  Object.assign(new Error("raw provider failure"), { status });
const geminiOk = (json: string) => ({ response: { text: () => json } });

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clearing leaves queued `*Once` values in
  // place, so an unconsumed queue from a failing test leaks into the next one.
  vi.resetAllMocks();
  geminiModels.length = 0;
  resetProviderCooldowns();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("provider SDK adapters", () => {
  it("reports an unconfigured deployment as config-missing, not a retryable outage", async () => {
    // Retryable would be a lie: no amount of retrying configures a provider,
    // and it left the Ask screen offering "Try again" forever.
    await expect(callJson({ system: "s", user: "u" })).rejects.toEqual({
      code: "AI_PROVIDER_CONFIG_MISSING",
      message: "AI processing is not configured.",
      retryable: false,
    });
    expect(openaiCreateMock).not.toHaveBeenCalled();
    expect(geminiGenerateContentMock).not.toHaveBeenCalled();
  });

  it("uses OpenAI alone when it succeeds", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-test";
    openaiCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"a":1}' } }],
    });

    await expect(callJson({ system: "s", user: "u" })).resolves.toEqual({
      a: 1,
    });
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
    expect(geminiGenerateContentMock).not.toHaveBeenCalled();
  });

  it("falls back to Gemini primary after a retryable OpenAI failure", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    openaiCreateMock.mockRejectedValueOnce(providerError(429));
    geminiGenerateContentMock.mockResolvedValueOnce(geminiOk('{"b":2}'));

    await expect(
      callJson({ system: "s", user: "u", maxRetries: 0 }),
    ).resolves.toEqual({ b: 2 });
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Gemini secondary after two retryable failures", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    process.env.GEMINI_API_KEY_FALLBACK = "gemini-fallback-test";
    openaiCreateMock.mockRejectedValueOnce(providerError(503));
    geminiGenerateContentMock
      .mockRejectedValueOnce(providerError(503))
      .mockResolvedValueOnce(geminiOk('{"c":3}'));

    await expect(
      callJson({ system: "s", user: "u", maxRetries: 0 }),
    ).resolves.toEqual({ c: 3 });
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back for a permanent request failure", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    const failure = providerError(400);
    openaiCreateMock.mockRejectedValueOnce(failure);

    await expect(
      callJson({ system: "s", user: "u", maxRetries: 0 }),
    ).rejects.toBe(failure);
    expect(geminiGenerateContentMock).not.toHaveBeenCalled();
  });

  it("does not fall back when a successful provider returns malformed JSON", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    openaiCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: "not-json" } }],
    });

    await expect(callJson({ system: "s", user: "u" })).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(geminiGenerateContentMock).not.toHaveBeenCalled();
  });

  it("strips a JSON code fence from Gemini output", async () => {
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    geminiGenerateContentMock.mockResolvedValueOnce(
      geminiOk('```json\n{"d":4}\n```'),
    );

    await expect(callJson({ system: "s", user: "u" })).resolves.toEqual({
      d: 4,
    });
  });

  it("rejects non-image input before calling a provider", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    await expect(
      visionTranscribe(Buffer.from("x"), "application/pdf"),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("falls back from OpenAI to Gemini for image transcription", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    openaiCreateMock.mockRejectedValue(providerError(503));
    geminiGenerateContentMock.mockResolvedValueOnce({
      response: { text: () => "transcribed text" },
    });

    await expect(
      visionTranscribe(Buffer.from("fake-png"), "image/png"),
    ).resolves.toBe("transcribed text");
  });

  it("falls back from OpenAI to a free OpenRouter model", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.OPENROUTER_API_KEY = "openrouter-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-test";
    openaiCreateMock
      .mockRejectedValueOnce(providerError(429))
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"e":5}' } }],
      });

    await expect(
      callJson({ system: "s", user: "u", maxRetries: 0 }),
    ).resolves.toEqual({ e: 5 });
    expect(openaiCreateMock).toHaveBeenCalledTimes(2);
    // Asserts the free OpenRouter default was used, not one particular slug:
    // OpenRouter retires free models regularly, and pinning the string here
    // meant a retired model broke the suite rather than being caught in prod.
    expect(openaiCreateMock.mock.calls[1]?.[0].model).toMatch(/:free$/);
  });

  it("uses OpenRouter when OpenAI is not configured", async () => {
    process.env.OPENROUTER_API_KEY = "openrouter-test";
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-test";
    openaiCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"f":6}' } }],
    });

    await expect(callJson({ system: "s", user: "u" })).resolves.toEqual({
      f: 6,
    });
    expect(openaiCreateMock.mock.calls[0]?.[0].model).toMatch(/:free$/);
  });

  it("honors an OpenRouter model override", async () => {
    process.env.OPENROUTER_API_KEY = "openrouter-test";
    openaiCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"h":8}' } }],
    });

    await expect(
      callJson({
        system: "s",
        user: "u",
        openrouterModel: "qwen/qwen3-coder:free",
      }),
    ).resolves.toEqual({ h: 8 });
    expect(openaiCreateMock.mock.calls[0]?.[0].model).toBe(
      "qwen/qwen3-coder:free",
    );
  });

  it("recovers structured JSON from prose-wrapped free-model output", async () => {
    process.env.OPENROUTER_API_KEY = "openrouter-test";
    openaiCreateMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Here you go:\n{"g":7}\nHope that helps!',
          },
        },
      ],
    });

    await expect(callJson({ system: "s", user: "u" })).resolves.toEqual({
      g: 7,
    });
  });

  it("uses GEMINI_FALLBACK_MODEL for the Gemini fallback slot", async () => {
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    process.env.GEMINI_API_KEY_FALLBACK = "gemini-fallback-test";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";
    process.env.GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";
    geminiGenerateContentMock
      .mockRejectedValueOnce(providerError(429))
      .mockResolvedValueOnce(geminiOk('{"j":10}'));

    await expect(
      callJson({ system: "s", user: "u", maxRetries: 0 }),
    ).resolves.toEqual({ j: 10 });
    expect(geminiModels).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("uses the primary Gemini model when only the primary slot is configured", async () => {
    process.env.GEMINI_API_KEY_PRIMARY = "gemini-primary-test";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";
    process.env.GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";
    geminiGenerateContentMock.mockResolvedValueOnce(geminiOk('{"k":11}'));

    await expect(callJson({ system: "s", user: "u" })).resolves.toEqual({
      k: 11,
    });
    expect(geminiModels).toEqual(["gemini-2.5-flash"]);
  });

  it("applies a configurable per-provider AI timeout", async () => {
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.AI_TIMEOUT_MS = "5";
    openaiCreateMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(providerError(500)), 50);
        }),
    );

    // OpenAI times out at 5ms, nothing else is configured -> safe unavailable.
    await expect(
      callJson({ system: "s", user: "u", maxRetries: 0 }),
    ).rejects.toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI processing is temporarily unavailable.",
      retryable: true,
    });
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });
});
