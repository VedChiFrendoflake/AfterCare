/**
 * Typed client for the AfterCare Express API (apps/api).
 *
 * Contract mirrors docs/api-openapi.yaml:
 *   POST /auth/register | /auth/login   -> { user, accessToken, refreshToken }
 *   POST /upload           (multipart "document")
 *   GET  /process/:id      (Server-Sent Events)
 *   GET  /medications?documentId= | /appointments?documentId=
 *   POST /medications/:id/taken | /appointments/:id/calendar
 *   POST /ask              { question, documentId }
 *   GET|POST /accessibility/prefs
 *   GET  /documents/:id/original
 *
 * Note: the API authenticates from the Authorization header only, and the native
 * EventSource API cannot send headers — so /process is consumed with fetch +
 * a streaming reader rather than EventSource.
 */

import {
  ACTION_INSTRUCTION,
  medicationSlots,
  type AskGroundedResult,
  type Appointment as PlanAppointment,
  type Medication as PlanMedication,
  type RecoveryPlan,
  type TimelineEntry,
} from "@discharge-guide/shared-types";
import { apiBaseUrl } from "./config";
import type { Appointment, Medication, RecoveryData, TimelineEvent } from "../types";

const TOKEN_KEY = "aftercare:tokens";

export interface BackendUser {
  id: string;
  email: string;
  /** Clinician accounts see the care dashboard instead of a recovery guide. */
  role?: "patient" | "clinician";
  displayName?: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  user: BackendUser;
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
    this.name = "SessionExpiredError";
  }
}

export function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens | null): void {
  try {
    if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session simply won't persist */
  }
}

export function clearSession(): void {
  writeTokens(null);
}

/**
 * An API failure that keeps the server's own code and retryability.
 *
 * Without these, every failure looked alike to the UI, so a permanent one
 * (a document whose stored copy is gone) was offered with a "Try again"
 * button that could never succeed.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly retryable: boolean,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; message?: string; code?: string; retryable?: boolean }
    | null;
  const message = body?.error ?? body?.message ?? `Request failed (${res.status})`;
  // Default to retryable only for 5xx: a 4xx won't change on a second press.
  const retryable = body?.retryable ?? res.status >= 500;
  return new ApiError(message, body?.code, retryable, res.status);
}

async function readError(res: Response): Promise<string> {
  return (await readApiError(res)).message;
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const tokens = readTokens();
  if (!tokens) throw new SessionExpiredError();
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (res.status === 401) {
    clearSession();
    throw new SessionExpiredError();
  }
  return res;
}

/* ------------------------------- auth ------------------------------- */

async function credentials(
  path: "register" | "login",
  email: string,
  password: string,
  extra: { role?: "patient" | "clinician"; displayName?: string } = {},
) {
  const res = await fetch(`${apiBaseUrl}/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, ...extra }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as StoredTokens;
  writeTokens(body);
  return body.user;
}

export const backendRegister = (
  email: string,
  password: string,
  role: "patient" | "clinician" = "patient",
  displayName?: string,
) =>
  credentials("register", email, password, { role, displayName });
export const backendLogin = (email: string, password: string) =>
  credentials("login", email, password);

/** Exchanges a Google ID token for an AfterCare session. */
export async function backendGoogleSignIn(idToken: string): Promise<BackendUser> {
  const res = await fetch(`${apiBaseUrl}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as StoredTokens;
  writeTokens(body);
  return body.user;
}

/* ------------------------------ documents ---------------------------- */

export interface UploadResult {
  documentId: string;
  status: string;
  deduplicated: boolean;
}

export async function backendUpload(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("document", file);
  const res = await authedFetch("/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as UploadResult;
}

export function originalDocumentUrl(documentId: string): string {
  return `${apiBaseUrl}/documents/${documentId}/original`;
}

export interface ProcessEvent {
  stage: string;
  status?: string;
  plan?: RecoveryPlan;
  error?: { code: string; message: string; retryable: boolean };
}

/**
 * Streams pipeline progress. Calls `onEvent` per stage, then exactly one of
 * `onComplete` / `onFailed`. Returns an abort function.
 */
export function streamProcess(
  documentId: string,
  handlers: {
    onEvent?: (event: ProcessEvent) => void;
    onComplete?: (plan: RecoveryPlan) => void;
    onFailed?: (message: string) => void;
  }
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await authedFetch(`/process/${documentId}`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        handlers.onFailed?.(await readError(res));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);

          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            // lines starting with ":" are heartbeats — ignored
          }
          if (dataLines.length === 0) continue;

          let payload: unknown = null;
          try {
            payload = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }

          if (eventName === "complete") {
            handlers.onComplete?.(payload as RecoveryPlan);
            return;
          }
          if (eventName === "failed") {
            const err = payload as { message?: string };
            handlers.onFailed?.(err.message ?? "Processing failed.");
            return;
          }
          handlers.onEvent?.({ stage: eventName, ...(payload as object) });
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      handlers.onFailed?.(err instanceof Error ? err.message : "Lost connection while processing.");
    }
  })();

  return () => controller.abort();
}

/* --------------------------- plan + actions -------------------------- */

export async function backendMedications(documentId: string): Promise<PlanMedication[]> {
  const res = await authedFetch(`/medications?documentId=${encodeURIComponent(documentId)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { data: PlanMedication[] }).data;
}

export async function backendAppointments(documentId: string): Promise<PlanAppointment[]> {
  const res = await authedFetch(`/appointments?documentId=${encodeURIComponent(documentId)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { data: PlanAppointment[] }).data;
}

export async function backendMarkTaken(medicationId: string): Promise<void> {
  const res = await authedFetch(`/medications/${medicationId}/taken`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res));
}

/**
 * How long to wait for an answer before giving up on it.
 *
 * The API allows each provider 45s and can walk a waterfall of four, so a
 * request that goes badly can outlast anyone's patience while showing no sign
 * of whether it is still working. 90s is past the point where a real answer is
 * plausible, and stopping there gives the reader the same honest "couldn't
 * answer" message a refusal would, rather than an endless spinner.
 */
const ASK_TIMEOUT_MS = 90_000;

/** Grounded answer plus the document lines it was drawn from. */
export async function backendAsk(
  documentId: string,
  question: string
): Promise<AskGroundedResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
  try {
    const res = await authedFetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, question }),
      signal: controller.signal,
    });
    if (!res.ok) throw await readApiError(res);
    return (await res.json()) as AskGroundedResult;
  } catch (error) {
    // Marked retryable: unlike a rejected question, waiting really can work.
    if ((error as Error)?.name === "AbortError") {
      throw new ApiError(
        "The assistant didn't answer in time. It may be busy — try again, or check the original document.",
        "ASK_TIMEOUT",
        true,
        504
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ mapping ------------------------------ */

/** Slot booleans for the medication cards, from the shared schedule parser. */
function splitTiming(timing: string, frequency: string) {
  const slots = medicationSlots(timing, frequency);
  return {
    morning: slots.includes("morning"),
    afternoon: slots.includes("afternoon"),
    evening: slots.includes("evening"),
  };
}

function splitDateTime(iso: string): { date: string; time: string } {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { date: iso, time: "" };
  return {
    date: parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: parsed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

function mapTimeline(entries: TimelineEntry[]): TimelineEvent[] {
  const today = new Date().setHours(0, 0, 0, 0);
  return entries.map((entry) => {
    let status: TimelineEvent["status"] = "upcoming";
    if (entry.date) {
      const when = new Date(entry.date).setHours(0, 0, 0, 0);
      if (!Number.isNaN(when)) status = when < today ? "done" : when === today ? "today" : "upcoming";
    }
    return {
      id: entry.id,
      label: entry.label,
      title: entry.label,
      description: entry.instructions,
      status,
      // Kept so Today's Plan can place this step on a day itself, rather than
      // re-deriving it from a status computed at mapping time.
      date: entry.date,
      sourceLines: entry.sourceLines,
    };
  });
}

/** Converts the API's RecoveryPlan into the shape the web screens render. */
export function planToRecoveryData(plan: RecoveryPlan): RecoveryData {
  const medications: Medication[] = plan.medications.map((med) => ({
    id: med.id,
    name: med.name,
    dose: med.dose,
    frequency: med.frequency,
    purpose: med.instructions,
    ...splitTiming(med.timing, med.frequency),
    foodInstructions: med.timing || undefined,
    timing: med.timing,
    takenAt: med.takenAt ?? [],
    sourceLines: med.sourceLines,
  }));

  const appointments: Appointment[] = plan.appointments.map((appt) => {
    const { date, time } = splitDateTime(appt.date);
    return {
      id: appt.id,
      providerName: appt.doctor,
      specialty: appt.specialty,
      location: appt.location,
      date,
      time,
      notes: appt.notes,
      // `date` above is localised for display and can't be parsed back; the
      // follow-up priority needs the machine-readable instant.
      isoDate: appt.date || undefined,
    };
  });

  // The pipeline's explanation stage feeds both Explain Terms and the
  // condition card. sourceExcerpt stays undefined: we have the cited line
  // numbers, not the line text, and inventing an excerpt would be a fabrication.
  const glossary = plan.explanations.map((explanation) => ({
    id: explanation.id,
    term: explanation.term,
    plainLanguage: explanation.plainText,
    sourceLines: explanation.sourceLines,
    confidence: explanation.confidence,
  }));

  return {
    documentId: plan.documentId,
    medications,
    appointments,
    timeline: mapTimeline(plan.timeline),
    glossary,
    faq: [],
    restrictions: [],
    redFlagSymptoms: plan.warnings.map((w) => `${w.symptom} — ${ACTION_INSTRUCTION[w.action]}`),
    // The structured warnings are carried through as well as flattened: the
    // symptom check-in escalates on `action`, which the display string loses.
    warnings: plan.warnings,
    processedAt: Date.now(),
    updatedAt: Date.now(),
  };
}
