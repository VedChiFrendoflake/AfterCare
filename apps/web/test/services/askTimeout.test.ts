import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, backendAsk } from "../../src/services/backend";

const TOKENS = {
  accessToken: "access",
  refreshToken: "refresh",
  user: { id: "u1", email: "patient@example.com" },
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem("aftercare:tokens", JSON.stringify(TOKENS));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

/**
 * The API allows each provider 45s and can walk four of them, so a bad request
 * can run far longer than anyone will sit through with no sign of progress.
 */
describe("backendAsk timeout", () => {
  it("gives up after 90s and says so", async () => {
    // A fetch that never settles unless its signal aborts.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );

    const pending = backendAsk("doc-1", "When do I take it?");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "ASK_TIMEOUT",
      // Retryable on purpose: unlike a rejected question, waiting can work.
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it("does not give up early", async () => {
    let settled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );

    const pending = backendAsk("doc-1", "When?").catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(89_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(settled).toBe(true);
  });

  it("passes a real answer straight through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answer: "Take it in the morning.",
          confidence: 90,
          source: { documentId: "doc-1", sourceLines: [2] },
        }),
      })),
    );

    await expect(backendAsk("doc-1", "When?")).resolves.toMatchObject({
      answer: "Take it in the morning.",
    });
  });

  it("leaves a server error's own message and retryability alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          error: "AI processing is not configured.",
          code: "AI_PROVIDER_CONFIG_MISSING",
          retryable: false,
        }),
      })),
    );

    const error = await backendAsk("doc-1", "When?").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    // A configuration problem must not be dressed up as a timeout, or as
    // something worth pressing "Try again" on.
    expect(error.code).toBe("AI_PROVIDER_CONFIG_MISSING");
    expect(error.retryable).toBe(false);
  });
});
