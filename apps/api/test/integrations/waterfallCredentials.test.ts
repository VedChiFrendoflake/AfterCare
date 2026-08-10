import { afterEach, describe, expect, it } from "vitest";
import {
  AiProviderFailure,
  configuredProviders,
  isProviderCredentialFailure,
  resetProviderCooldowns,
  runAiProviderWaterfall,
} from "../../src/integrations/aiProviderWaterfall.js";

const credentials = {
  openai: "openai-test-key-never-log",
  openrouter: "openrouter-test-key-never-log",
  geminiPrimary: "gemini-primary-test-key-never-log",
};

afterEach(() => {
  resetProviderCooldowns();
});

const rejected = (status: number) =>
  Object.assign(new Error("rejected"), { status });

describe("waterfall credential handling", () => {
  it("recognises a rejected key, and only a rejected key", () => {
    expect(isProviderCredentialFailure(rejected(401))).toBe(true);
    expect(isProviderCredentialFailure({ statusCode: 403 })).toBe(true);
    expect(
      isProviderCredentialFailure(new AiProviderFailure("authentication")),
    ).toBe(true);
    expect(
      isProviderCredentialFailure(new AiProviderFailure("authorization")),
    ).toBe(true);

    expect(isProviderCredentialFailure(rejected(429))).toBe(false);
    expect(isProviderCredentialFailure(new AiProviderFailure("server"))).toBe(false);
    expect(isProviderCredentialFailure(new AiProviderFailure("programming"))).toBe(
      false,
    );
  });

  it("walks past a rejected key to the next provider", async () => {
    const tried: string[] = [];
    const result = await runAiProviderWaterfall(async (context) => {
      tried.push(context.slot);
      if (context.slot === "openai") throw rejected(401);
      return "answered";
    }, credentials);

    expect(tried).toEqual(["openai", "openrouter"]);
    expect(result).toBe("answered");
  });

  it("keeps going when several keys are rejected", async () => {
    const tried: string[] = [];
    const result = await runAiProviderWaterfall(async (context) => {
      tried.push(context.slot);
      if (context.slot === "openai") throw rejected(401);
      if (context.slot === "openrouter") throw rejected(403);
      return "gemini answered";
    }, credentials);

    expect(tried).toEqual(["openai", "openrouter", "gemini_primary"]);
    expect(result).toBe("gemini answered");
  });

  /**
   * The loud half of the original design, kept. Reporting a permanently bad
   * configuration as a retryable outage is what invited the endless "try
   * again" loop the PROVIDER_CONFIG_MISSING comment was written about.
   */
  it("reports configuration, not an outage, when every key is rejected", async () => {
    const result = await runAiProviderWaterfall(async () => {
      throw rejected(401);
    }, credentials);

    expect(result).toMatchObject({
      code: "AI_PROVIDER_CONFIG_MISSING",
      retryable: false,
    });
  });

  it("still reports a retryable outage when providers are merely busy", async () => {
    const result = await runAiProviderWaterfall(async () => {
      throw rejected(429);
    }, credentials);

    expect(result).toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("calls it configuration only when nothing else was wrong", async () => {
    // One rejected key and one busy provider is not a pure config problem, so
    // the retryable outage is still the honest answer.
    const result = await runAiProviderWaterfall(async (context) => {
      if (context.slot === "openai") throw rejected(401);
      throw rejected(429);
    }, credentials);

    expect(result).toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("still short-circuits on a validation failure", async () => {
    const tried: string[] = [];
    const result = await runAiProviderWaterfall(async (context) => {
      tried.push(context.slot);
      throw new AiProviderFailure("validation");
    }, credentials);

    // A rejected answer is about the content, not the provider — another
    // provider would only produce the same unusable result.
    expect(tried).toEqual(["openai"]);
    expect(result).toMatchObject({ code: "AI_VALIDATION_FAILED" });
  });
});

describe("configuredProviders", () => {
  it("counts a real key as configured", () => {
    expect(configuredProviders({ openai: "sk-real", openrouter: "or-real" })).toMatchObject({
      openai: true,
      openrouter: true,
      geminiPrimary: false,
      geminiFallback: false,
    });
  });

  it("does not count a blank or whitespace key", () => {
    // The case that made this undebuggable: /health said configured while the
    // waterfall skipped the provider, so requests failed instantly with no
    // cooldown to point at.
    expect(
      configuredProviders({ openai: "", openrouter: "   ", geminiPrimary: "\n\t" }),
    ).toMatchObject({
      openai: false,
      openrouter: false,
      geminiPrimary: false,
      geminiFallback: false,
    });
  });

  it("agrees with what the waterfall attempts", async () => {
    const creds = { openai: "  ", openrouter: "or-real" };
    const tried: string[] = [];
    await runAiProviderWaterfall(async (context) => {
      tried.push(context.slot);
      return "ok";
    }, creds);

    const reported = configuredProviders(creds);
    expect(reported.openai).toBe(false);
    expect(tried).toEqual(["openrouter"]);
  });
});
