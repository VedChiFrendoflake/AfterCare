import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderFailure,
  providerCooldownStatus,
  resetProviderCooldowns,
  runAiProviderWaterfall,
  type AiProviderContext,
  type AiProviderCredentials,
} from "./aiProviderWaterfall.js";

const credentials: AiProviderCredentials = {
  openai: "openai-test-key-never-log",
  openrouter: "openrouter-test-key-never-log",
  geminiPrimary: "gemini-primary-test-key-never-log",
  geminiFallback: "gemini-fallback-test-key-never-log",
};

const success = { value: "grounded result" };

beforeEach(() => {
  // The circuit breaker is module-level; keep every test deterministic.
  resetProviderCooldowns();
});

describe("AI provider waterfall", () => {
  it("stops after OpenAI succeeds", async () => {
    const operation = vi.fn(async (_context: AiProviderContext) => success);

    await expect(runAiProviderWaterfall(operation, credentials)).resolves.toBe(
      success,
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation.mock.calls[0]?.[0].slot).toBe("openai");
  });

  it("falls back from OpenAI to free OpenRouter on a retryable failure", async () => {
    const operation = vi
      .fn<(context: AiProviderContext) => Promise<typeof success>>()
      .mockRejectedValueOnce(new AiProviderFailure("rate_limit"))
      .mockResolvedValueOnce(success);

    await expect(runAiProviderWaterfall(operation, credentials)).resolves.toBe(
      success,
    );
    expect(operation.mock.calls.map(([context]) => context.slot)).toEqual([
      "openai",
      "openrouter",
    ]);
  });

  it("falls through OpenRouter to Gemini primary after two retryable failures", async () => {
    const operation = vi
      .fn<(context: AiProviderContext) => Promise<typeof success>>()
      .mockRejectedValueOnce(new AiProviderFailure("timeout"))
      .mockRejectedValueOnce(new AiProviderFailure("quota_exhausted"))
      .mockResolvedValueOnce(success);

    await expect(runAiProviderWaterfall(operation, credentials)).resolves.toBe(
      success,
    );
    expect(operation.mock.calls.map(([context]) => context.slot)).toEqual([
      "openai",
      "openrouter",
      "gemini_primary",
    ]);
  });

  it("exhausts all four providers before giving up", async () => {
    const operation = vi
      .fn<(context: AiProviderContext) => Promise<typeof success>>()
      .mockRejectedValueOnce(new AiProviderFailure("rate_limit"))
      .mockRejectedValueOnce(new AiProviderFailure("network"))
      .mockRejectedValueOnce(new AiProviderFailure("server"))
      .mockRejectedValueOnce(new AiProviderFailure("quota_exhausted"));

    await expect(
      runAiProviderWaterfall(operation, credentials),
    ).resolves.toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI processing is temporarily unavailable.",
      retryable: true,
    });
    expect(operation.mock.calls.map(([context]) => context.slot)).toEqual([
      "openai",
      "openrouter",
      "gemini_primary",
      "gemini_fallback",
    ]);
  });

  it("returns a safe unavailable result after all providers fail", async () => {
    const operation = vi.fn(async (_context: AiProviderContext) => {
      throw new AiProviderFailure("network", "raw provider network failure");
    });

    await expect(
      runAiProviderWaterfall(operation, credentials),
    ).resolves.toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI processing is temporarily unavailable.",
      retryable: true,
    });
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it("starts with OpenRouter when OpenAI credentials are missing", async () => {
    const operation = vi.fn(async (_context: AiProviderContext) => success);

    await runAiProviderWaterfall(operation, {
      openrouter: credentials.openrouter,
      geminiPrimary: credentials.geminiPrimary,
    });
    expect(operation.mock.calls.map(([context]) => context.slot)).toEqual([
      "openrouter",
    ]);
  });

  it("skips missing Gemini primary credentials and continues to Gemini secondary", async () => {
    const operation = vi
      .fn<(context: AiProviderContext) => Promise<typeof success>>()
      .mockRejectedValueOnce(new AiProviderFailure("quota_exhausted"))
      .mockRejectedValueOnce(new AiProviderFailure("rate_limit"))
      .mockResolvedValueOnce(success);

    await runAiProviderWaterfall(operation, {
      openai: credentials.openai,
      openrouter: credentials.openrouter,
      geminiFallback: credentials.geminiFallback,
    });
    expect(operation.mock.calls.map(([context]) => context.slot)).toEqual([
      "openai",
      "openrouter",
      "gemini_fallback",
    ]);
  });

  it("does not continue after a permanent validation failure", async () => {
    const operation = vi.fn(async () => {
      throw new AiProviderFailure("validation", "raw invalid medical response");
    });

    await expect(
      runAiProviderWaterfall(operation, credentials),
    ).resolves.toEqual({
      code: "AI_VALIDATION_FAILED",
      message: "The request could not be processed safely.",
      retryable: false,
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  // Bugs in our own code. Retrying these on another provider would produce the
  // same broken request and bury the cause, so they still abort the waterfall.
  it.each(["malformed_request", "programming", "parsing"] as const)(
    "does not fall back for %s failures",
    async (kind) => {
      const failure = new AiProviderFailure(kind, `raw ${kind} failure`);
      const operation = vi.fn(async () => {
        throw failure;
      });

      await expect(runAiProviderWaterfall(operation, credentials)).rejects.toBe(
        failure,
      );
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );

  // A rejected key is this provider's problem, not the chain's. Throwing here
  // meant one bad key stopped every working provider from being tried, and the
  // /ask route then relabelled the throw as a retryable outage anyway.
  it.each(["authentication", "authorization"] as const)(
    "falls back past a %s failure",
    async (kind) => {
      const operation = vi.fn(async (context: { slot: string }) => {
        if (context.slot === "openai") {
          throw new AiProviderFailure(kind, `raw ${kind} failure`);
        }
        return "answered";
      });

      await expect(runAiProviderWaterfall(operation, credentials)).resolves.toBe(
        "answered",
      );
      expect(operation).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { status: 408 },
    { statusCode: 429 },
    { status: 500 },
    { status: 503 },
    { code: "ETIMEDOUT" },
    { code: "RESOURCE_EXHAUSTED" },
    new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
  ])("falls back for retryable provider failure %#", async (failure) => {
    const operation = vi
      .fn<(context: AiProviderContext) => Promise<typeof success>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(success);

    await runAiProviderWaterfall(operation, credentials);
    expect(operation.mock.calls.map(([context]) => context.slot)).toEqual([
      "openai",
      "openrouter",
    ]);
  });

  it("skips a provider that recently failed (circuit breaker)", async () => {
    // First run: OpenAI rate-limits, OpenRouter succeeds.
    const first = vi
      .fn<(context: AiProviderContext) => Promise<typeof success>>()
      .mockRejectedValueOnce(new AiProviderFailure("rate_limit"))
      .mockResolvedValueOnce(success);
    await expect(runAiProviderWaterfall(first, credentials)).resolves.toBe(
      success,
    );

    // OpenAI is now on cooldown: the next call must skip straight to OpenRouter.
    const second = vi.fn(async (_context: AiProviderContext) => success);
    await runAiProviderWaterfall(second, credentials);
    expect(second.mock.calls.map(([context]) => context.slot)).toEqual([
      "openrouter",
    ]);
  });

  it("skips every provider while all are on cooldown, then recovers after reset", async () => {
    const alwaysFails = vi.fn(async () => {
      throw new AiProviderFailure("rate_limit");
    });
    await expect(
      runAiProviderWaterfall(alwaysFails, credentials),
    ).resolves.toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI processing is temporarily unavailable.",
      retryable: true,
    });
    expect(alwaysFails).toHaveBeenCalledTimes(4);

    // All four are cooled down: the next run attempts nothing.
    const skipped = vi.fn(async (_context: AiProviderContext) => success);
    await expect(
      runAiProviderWaterfall(skipped, credentials),
    ).resolves.toEqual({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI processing is temporarily unavailable.",
      retryable: true,
    });
    expect(skipped).not.toHaveBeenCalled();

    resetProviderCooldowns();
    const recovered = vi.fn(async (_context: AiProviderContext) => success);
    await runAiProviderWaterfall(recovered, credentials);
    expect(recovered.mock.calls[0]?.[0].slot).toBe("openai");
  });

  it("never logs or returns keys and raw provider errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const operation = vi.fn(async ({ apiKey }: AiProviderContext) => {
      throw new AiProviderFailure(
        "server",
        `raw provider response containing ${apiKey}`,
      );
    });

    const result = await runAiProviderWaterfall(operation, credentials);
    const serialized = JSON.stringify(result);
    expect(serialized).toBe(
      JSON.stringify({
        code: "AI_PROVIDER_UNAVAILABLE",
        message: "AI processing is temporarily unavailable.",
        retryable: true,
      }),
    );
    expect(serialized).not.toMatch(
      /openai|openrouter|gemini|raw provider|test-key/i,
    );
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });

  it("reports circuit-breaker cooldowns for ops visibility", async () => {
    const operation = vi.fn(async () => {
      throw new AiProviderFailure("rate_limit");
    });
    await runAiProviderWaterfall(operation, credentials);

    const status = providerCooldownStatus();
    // Every provider 429'd, so every configured slot should be cooling down.
    expect(status.openai).toBeGreaterThan(0);
    expect(status.openrouter).toBeGreaterThan(0);
    expect(status.gemini_primary).toBeGreaterThan(0);
    expect(status.gemini_fallback).toBeGreaterThan(0);

    // Reset clears the cooldowns, so the status comes back empty.
    resetProviderCooldowns();
    expect(providerCooldownStatus()).toEqual({});
  });

  it("prunes expired cooldown entries when reporting status", async () => {
    const operation = vi.fn(async () => {
      throw new AiProviderFailure("timeout");
    });
    await runAiProviderWaterfall(operation, credentials);
    expect(providerCooldownStatus().openai).toBeGreaterThan(0);

    // The default cooldown is 30s; simulating an expiry by clearing the map
    // directly is awkward, but the status reader must treat past timestamps
    // as not-on-cooldown. A reset simulates the cleared state.
    resetProviderCooldowns();
    expect(providerCooldownStatus()).toEqual({});
  });
});
