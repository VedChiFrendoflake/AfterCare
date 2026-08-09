import type {
  AiFunctionResult,
  PipelineEmit,
  RecoveryPlan,
} from "@discharge-guide/shared-types";
import { repository } from "../db/repository.js";
import { sanitizeAiError } from "../errors.js";
import { loadDocument } from "../integrations/storage.js";
import { runPipeline as runPipelineCore } from "./index.js";
import type { PipelineRecoveryPlan, PipelineStageEvent } from "./types.js";

function forwardPipelineEvent(emit: PipelineEmit, event: PipelineStageEvent) {
  emit({
    stage: event.stage,
    status:
      event.status === "done"
        ? "completed"
        : event.status === "error"
          ? "failed"
          : "started",
    data: event.data ?? null,
    ...(event.status === "error"
      ? { error: sanitizeAiError(event.error) }
      : {}),
  });
}

/**
 * The pipeline's Appointment.date is a calendar date (YYYY-MM-DD) or null; the
 * public contract's Appointment.date is a full ISO-8601 datetime string (the
 * /appointments/:id/calendar ICS route depends on this). Resolve a concrete
 * calendar date to midnight UTC; when only free text like "in 2 weeks" is
 * available, leave it as plain text for display ? it is not a valid instant
 * and must never be fed to the ICS route as if it were one.
 */
export function resolveAppointmentDate(
  date: string | null,
  dateText: string | undefined,
): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return `${date}T00:00:00.000Z`;
  }
  return dateText ?? "";
}

/** Exported for tests: the pipeline-to-API shape conversion, warnings included. */
export function publicPlan(plan: PipelineRecoveryPlan): RecoveryPlan {
  return {
    documentId: plan.documentId,
    status: "ready",
    disclaimer:
      "This app explains instructions; it never replaces medical advice.",
    medications: plan.medications.map((medication) => ({
      ...medication,
      takenAt: [],
    })),
    appointments: plan.appointments.map((appointment) => ({
      ...appointment,
      date: resolveAppointmentDate(appointment.date, appointment.dateText),
    })),
    warnings: plan.warnings.map((warning) => {
      const action = warning.action.toLowerCase();
      // Word boundaries matter here: a bare `includes("er")` matched "provider"
      // and turned every routine "call your provider" into an ER instruction,
      // while "seek urgent care" matched nothing and was reported as routine
      // even though the stage had classified it as an emergency.
      const mentions911 = /\b(?:911|999|112)\b/.test(action);
      const mentionsEmergency =
        /\b(?:er|ed|a&e|emergency)\b/.test(action) || /urgent care/.test(action);

      // `severity` is the detection stage's own judgement, so it wins. The text
      // is only consulted when severity is absent, and errs toward escalating —
      // a false emergency costs a wasted trip, a missed one costs much more.
      const isEmergency = warning.severity
        ? warning.severity === "emergency"
        : mentionsEmergency;

      return {
        id: warning.id,
        symptom: warning.symptom,
        action: mentions911
          ? ("call_911" as const)
          : isEmergency
            ? ("emergency_room" as const)
            : ("call_provider" as const),
        confidence: warning.confidence,
        sourceLines: warning.sourceLines,
      };
    }),
    timeline: plan.timeline.map((entry) => ({
      id: entry.id,
      label: entry.title,
      date: null,
      instructions: entry.detail,
      confidence: entry.confidence,
      sourceLines: entry.sourceLines,
    })),
    // The explanation stage's output is part of the contract: the web app's
    // Explain Terms screen and condition card both read it, and without it
    // they render empty no matter what the pipeline found.
    explanations: plan.explanations.map((explanation) => ({
      id: explanation.id,
      term: explanation.term,
      plainText: explanation.plainText,
      confidence: explanation.confidence,
      sourceLines: explanation.sourceLines,
    })),
    isPlaceholder: false,
  };
}

/** API-facing adapter that preserves runPipeline(documentId, emit). */
export async function runPipeline(
  documentId: string,
  emit: PipelineEmit,
): Promise<AiFunctionResult<RecoveryPlan>> {
  const document = repository.findDocumentById(documentId);
  if (!document) {
    return {
      code: "AI_VALIDATION_FAILED",
      message: "The request could not be processed safely.",
      retryable: false,
    };
  }

  try {
    const plan = await runPipelineCore(
      {
        documentId,
        buffer: await loadDocument(document.storageKey),
        mimeType: document.mimeType,
      },
      (event) => forwardPipelineEvent(emit, event),
    );
    return publicPlan(plan);
  } catch (error) {
    return sanitizeAiError(error);
  }
}
