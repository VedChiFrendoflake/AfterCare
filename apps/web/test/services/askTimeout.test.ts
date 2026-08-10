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

describe("backendAsk retry across a provider cooldown", () => {
  function jsonResponse(status: number, body: unknown) {
    return { ok: status < 400, status, json: async () => body };
  }

  it("waits out a temporary refusal and succeeds on the second try", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(503, {
          error: "AI processing is temporarily unavailable.",
          code: "AI_PROVIDER_UNAVAILABLE",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          answer: "Take it in the morning.",
          confidence: 90,
          source: { documentId: "doc-1", sourceLines: [2] },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const onRetrying = vi.fn();
    const pending = backendAsk("doc-1", "When?", onRetrying);
    await vi.advanceTimersByTimeAsync(33_000);

    await expect(pending).resolves.toMatchObject({
      answer: "Take it in the morning.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The screen needs this to explain a 30s wait rather than sit silent.
    expect(onRetrying).toHaveBeenCalledOnce();
  });

  it("does not retry a permanent failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(503, {
        error: "AI processing is not configured.",
        code: "AI_PROVIDER_CONFIG_MISSING",
        retryable: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onRetrying = vi.fn();
    const error = await backendAsk("doc-1", "When?", onRetrying).catch((e) => e);

    // Burning 30s of the budget to arrive at the same answer helps nobody.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetrying).not.toHaveBeenCalled();
    expect(error.code).toBe("AI_PROVIDER_CONFIG_MISSING");
  });

  it("gives up if the retry is still refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(503, {
        error: "AI processing is temporarily unavailable.",
        code: "AI_PROVIDER_UNAVAILABLE",
        retryable: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const settled = backendAsk("doc-1", "When?").catch((e) => e);
    await vi.advanceTimersByTimeAsync(33_000);
    const error = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });
});
