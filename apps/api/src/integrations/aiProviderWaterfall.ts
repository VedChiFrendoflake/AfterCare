import type {
  AiFunctionResult,
  StructuredAiError,
} from "@discharge-guide/shared-types";
import { config } from "../config.js";

export type AiProviderSlot =
  "openai" | "openrouter" | "gemini_primary" | "gemini_fallback";

export interface AiProviderContext {
  apiKey: string;
  family: "openai" | "openrouter" | "gemini";
  slot: AiProviderSlot;
}

export interface AiProviderCredentials {
  openai?: string;
  openrouter?: string;
  geminiPrimary?: string;
  geminiFallback?: string;
}

export type AiProviderOperation<T> = (context: AiProviderContext) => Promise<T>;

export type AiProviderFailureKind =
  | "rate_limit"
  | "quota_exhausted"
  | "timeout"
  | "network"
  | "server"
  | "validation"
  | "authentication"
  | "authorization"
  | "malformed_request"
  | "programming"
  | "parsing";

export class AiProviderFailure extends Error {
  constructor(
    public readonly kind: AiProviderFailureKind,
    message = "AI provider request failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const PROVIDER_UNAVAILABLE: StructuredAiError = {
  code: "AI_PROVIDER_UNAVAILABLE",
  message: "AI processing is temporarily unavailable.",
  retryable: true,
};

const PROVIDER_CONFIG_MISSING: StructuredAiError = {
  code: "AI_PROVIDER_CONFIG_MISSING",
  message: "AI processing is not configured.",
  retryable: false,
};

const VALIDATION_FAILED: StructuredAiError = {
  code: "AI_VALIDATION_FAILED",
  message: "The request could not be processed safely.",
  retryable: false,
};

const retryableKinds = new Set<AiProviderFailureKind>([
  "rate_limit",
  "quota_exhausted",
  "timeout",
  "network",
  "server",
]);

const retryableCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "RATE_LIMIT_EXCEEDED",
  "REQUEST_TIMEOUT",
  "RESOURCE_EXHAUSTED",
  "SERVICE_UNAVAILABLE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusCode(error: unknown) {
  if (!isRecord(error)) return undefined;
  const status = error.statusCode ?? error.status;
  return typeof status === "number" ? status : undefined;
}

function errorCode(error: unknown) {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

export function isRetryableAiProviderFailure(error: unknown) {
  if (error instanceof AiProviderFailure) {
    return retryableKinds.has(error.kind);
  }
  if (isRecord(error) && error.retryable === true) return true;
  const status = statusCode(error);
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status < 600)
  ) {
    return true;
  }
  const name = error instanceof Error ? error.name : undefined;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code =
    errorCode(error) ?? (isRecord(error) ? errorCode(error.cause) : undefined);
  return code !== undefined && retryableCodes.has(code);
}

function isValidationFailure(error: unknown) {
  return (
    (error instanceof AiProviderFailure && error.kind === "validation") ||
    (isRecord(error) && error.code === "AI_VALIDATION_FAILED")
  );
}

/**
 * A key the provider rejected: wrong, revoked, or without access to the model.
 *
 * These used to be thrown, on the principle that a misconfiguration should fail
 * loudly rather than hide behind a fallback. The principle is right; throwing
 * here did not achieve it. The throw escapes the waterfall, and the /ask route
 * hands anything unrecognised to `sanitizeAiError`, whose default is
 * AI_PROVIDER_UNAVAILABLE with retryable: true — so a permanently bad key was
 * reported to the patient as a temporary outage, and the other providers never
 * got a turn. Worst of both.
 *
 * A rejected key now costs that provider and nothing more. Loudness is
 * preserved where it belongs: if *every* configured provider rejects its key,
 * the waterfall reports AI_PROVIDER_CONFIG_MISSING — not retryable — instead of
 * pretending the service will come back on its own.
 *
 * Deliberately narrow. `malformed_request`, `programming` and `parsing` are
 * bugs in our own code and still throw, because retrying them on a different
 * provider would only hide them.
 */
export function isProviderCredentialFailure(error: unknown) {
  if (error instanceof AiProviderFailure) {
    return error.kind === "authentication" || error.kind === "authorization";
  }
  const status = statusCode(error);
  return status === 401 || status === 403;
}

/**
 * Circuit breaker: after a provider fails with a retryable error, it is
 * skipped for a short cooldown so a 429'd provider isn't hammered again on
 * the very next call. Free tiers (OpenRouter `:free`, Gemini free) 429 often,
 * so this keeps fallbacks snappy under load. Configurable via
 * AI_PROVIDER_COOLDOWN_MS; 0 disables the breaker.
 */
const DEFAULT_PROVIDER_COOLDOWN_MS = 30_000;
const providerCooldowns = new Map<AiProviderSlot, number>();

function providerCooldownMs(): number {
  const raw = process.env.AI_PROVIDER_COOLDOWN_MS;
  // An empty or whitespace-only value is "unset", not "0" (Number("") is 0).
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROVIDER_COOLDOWN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_PROVIDER_COOLDOWN_MS;
}

/** Clears the circuit-breaker state. Primarily for tests. */
export function resetProviderCooldowns(): void {
  providerCooldowns.clear();
}

function isOnCooldown(slot: AiProviderSlot, now: number): boolean {
  const until = providerCooldowns.get(slot);
  return until !== undefined && until > now;
}

/**
 * Ops visibility into the circuit breaker: how many ms each provider is
 * currently cooling down for, or omitted when not on cooldown. Expired
 * entries are pruned on read so the map never accumulates stale slots.
 */
export function providerCooldownStatus(): Partial<
  Record<AiProviderSlot, number>
> {
  const now = Date.now();
  const status: Partial<Record<AiProviderSlot, number>> = {};
  for (const [slot, until] of providerCooldowns) {
    if (until <= now) {
      providerCooldowns.delete(slot);
    } else {
      status[slot] = until - now;
    }
  }
  return status;
}

function configuredCredentials(): AiProviderCredentials {
  return {
    openai: config.OPENAI_API_KEY,
    openrouter: config.OPENROUTER_API_KEY,
    geminiPrimary: config.GEMINI_API_KEY_PRIMARY,
    geminiFallback: config.GEMINI_API_KEY_FALLBACK,
  };
}

function normalizedCredential(value: string | undefined) {
  const credential = value?.trim();
  return credential ? credential : undefined;
}

/**
 * Which providers the waterfall will actually attempt.
 *
 * Exported so /health reports this rather than `Boolean(key)`. The two
 * disagreed on a key that was present but empty or whitespace — Render will
 * happily store one — and /health called it configured while the waterfall
 * skipped it. That combination is close to undebuggable from outside: the
 * status page says the provider is there, and requests fail instantly with no
 * cooldown to show for it.
 */
export function configuredProviders(
  credentials: AiProviderCredentials = configuredCredentials(),
): Record<keyof AiProviderCredentials, boolean> {
  return {
    openai: normalizedCredential(credentials.openai) !== undefined,
    openrouter: normalizedCredential(credentials.openrouter) !== undefined,
    geminiPrimary: normalizedCredential(credentials.geminiPrimary) !== undefined,
    geminiFallback:
      normalizedCredential(credentials.geminiFallback) !== undefined,
  };
}

export async function runAiProviderWaterfall<T>(
  operation: AiProviderOperation<T>,
  credentials: AiProviderCredentials = configuredCredentials(),
): Promise<AiFunctionResult<T>> {
  // Order matters: paid OpenAI first (strongest), then free OpenRouter and
  // free Gemini as budget-friendly fallbacks, so a missing quota never
  // blocks the pipeline while free capacity exists.
  const providers: Array<{
    apiKey?: string;
    family: AiProviderContext["family"];
    slot: AiProviderSlot;
  }> = [
    {
      slot: "openai",
      family: "openai",
      apiKey: normalizedCredential(credentials.openai),
    },
    {
      slot: "openrouter",
      family: "openrouter",
      apiKey: normalizedCredential(credentials.openrouter),
    },
    {
      slot: "gemini_primary",
      family: "gemini",
      apiKey: normalizedCredential(credentials.geminiPrimary),
    },
    {
      slot: "gemini_fallback",
      family: "gemini",
      apiKey: normalizedCredential(credentials.geminiFallback),
    },
  ];

  // No credentials at all is a deployment mistake, not an outage. Reporting it
  // as "temporarily unavailable / retryable" sent users into an endless
  // "try again" loop for something that will never come back on its own.
  if (!providers.some((provider) => provider.apiKey)) {
    return { ...PROVIDER_CONFIG_MISSING };
  }

  const now = Date.now();
  // Tracked so the outcome can tell "every key was rejected" (a deployment
  // problem, not retryable) apart from "providers were busy" (retryable).
  let attempted = 0;
  let credentialRejections = 0;

  for (const provider of providers) {
    if (!provider.apiKey) continue;
    if (isOnCooldown(provider.slot, now)) continue;
    attempted += 1;
    try {
      return await operation({
        apiKey: provider.apiKey,
        family: provider.family,
        slot: provider.slot,
      });
    } catch (error) {
      if (isValidationFailure(error)) return { ...VALIDATION_FAILED };
      if (isProviderCredentialFailure(error)) {
        credentialRejections += 1;
        // Sat out far longer than a rate limit: a rejected key does not
        // recover on its own, so re-testing it every 30s only adds latency to
        // every request that has to walk past it.
        providerCooldowns.set(
          provider.slot,
          Date.now() + providerCooldownMs() * 10,
        );
        continue;
      }
      if (!isRetryableAiProviderFailure(error)) throw error;
      providerCooldowns.set(provider.slot, Date.now() + providerCooldownMs());
    }
  }

  // Every provider we actually tried rejected its key. Calling that a
  // temporary outage would invite a patient to keep retrying something that
  // will never succeed until someone fixes the configuration.
  if (attempted > 0 && credentialRejections === attempted) {
    return { ...PROVIDER_CONFIG_MISSING };
  }

  return { ...PROVIDER_UNAVAILABLE };
}
