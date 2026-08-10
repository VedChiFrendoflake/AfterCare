import type {
  PipelineEvent,
  RecoveryPlan,
  StructuredAiError,
} from "@discharge-guide/shared-types";
import { EventEmitter } from "node:events";
import { repository } from "../db/repository.js";
import { isStructuredAiError, sanitizeAiError } from "../errors.js";
import { runPipeline } from "../pipeline/orchestrator.js";
import type { OcrResult } from "../pipeline/types.js";

/** Narrow the stage event's `unknown` payload before persisting it. */
function isOcrResult(value: unknown): value is OcrResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { lines?: unknown; text?: unknown };
  return Array.isArray(candidate.lines) && typeof candidate.text === "string";
}

export interface StreamEvent extends PipelineEvent {
  documentId: string;
  timestamp: string;
}

interface QueueJob {
  documentId: string;
  attempts: number;
  state: "queued" | "running" | "completed" | "failed";
  errorCode?: string;
  /** Set when the job reaches a terminal state, for retention pruning. */
  endedAt?: number;
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

type PipelineRunner = typeof runPipeline;

export interface PipelineQueueOptions {
  /**
   * How long a terminal (completed/failed) job, its SSE history, and its
   * dead-letter entry are kept before being pruned. Defaults to 30 minutes.
   * Set to 0 to disable pruning entirely (retains everything; mostly tests).
   */
  retentionMs?: number;
  /** Max SSE events retained per document. Defaults to 500. */
  maxHistoryPerDocument?: number;
}

const DEFAULT_RETENTION_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_HISTORY = 500;

export function createPipelineQueue(
  runner: PipelineRunner = runPipeline,
  options: PipelineQueueOptions = {},
) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const history = new Map<string, StreamEvent[]>();
  const jobs = new Map<string, QueueJob>();
  const deadLetterQueue = new Map<string, QueueJob>();
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxHistoryPerDocument =
    options.maxHistoryPerDocument ?? DEFAULT_MAX_HISTORY;

  function publish(documentId: string, event: PipelineEvent) {
    // Keep the transcription the pipeline just produced. /ask used to reload
    // the file and run OCR a second time to answer a question — for an image
    // that meant a fresh vision call per question, and when that pass failed
    // the answer came back as an AI outage despite no provider having been
    // contacted at all.
    if (
      event.stage === "ocr" &&
      event.status === "completed" &&
      isOcrResult(event.data)
    ) {
      repository.updateDocument(documentId, { ocr: event.data });
    }

    const streamEvent = {
      ...event,
      ...(event.status === "failed" && event.error
        ? { error: sanitizeAiError(event.error), data: null }
        : {}),
      documentId,
      timestamp: new Date().toISOString(),
    };
    const documentHistory = history.get(documentId) ?? [];
    documentHistory.push(streamEvent);
    // A single document can emit a lot of SSE events (retries re-emit each
    // stage); cap so a long-running process can't accumulate unbounded text.
    if (documentHistory.length > maxHistoryPerDocument) {
      documentHistory.splice(0, documentHistory.length - maxHistoryPerDocument);
    }
    history.set(documentId, documentHistory);
    events.emit(documentId, streamEvent);
  }

  /**
   * Drops terminal jobs, their history, and their dead-letter entries once
   * they've outlived the retention window. Without this, a long-running
   * process accumulates every document ever processed in memory.
   */
  function prune(now = Date.now()) {
    if (retentionMs <= 0) return;
    const cutoff = now - retentionMs;
    for (const [documentId, job] of jobs) {
      if (job.state !== "completed" && job.state !== "failed") {
        continue;
      }
      if ((job.endedAt ?? 0) > cutoff) continue;
      jobs.delete(documentId);
      history.delete(documentId);
      deadLetterQueue.delete(documentId);
    }
  }

  async function run(job: QueueJob) {
    job.state = "running";
    repository.updateDocument(job.documentId, { status: "processing" });
    try {
      const result = await runner(job.documentId, (event) =>
        publish(job.documentId, event),
      );
      if (isStructuredAiError(result)) throw result;
      const plan: RecoveryPlan = result;
      repository.savePlan(job.documentId, plan);
      job.state = "completed";
      job.endedAt = Date.now();
      events.emit(`${job.documentId}:complete`, plan);
    } catch (error) {
      const publicError = sanitizeAiError(error);
      job.attempts += 1;
      if (publicError.retryable && job.attempts < 3) {
        await delay(25 * 2 ** (job.attempts - 1));
        await run(job);
        return;
      }
      job.state = "failed";
      job.endedAt = Date.now();
      job.errorCode = publicError.code;
      deadLetterQueue.set(job.documentId, { ...job });
      repository.updateDocument(job.documentId, {
        status: "failed",
        failure: publicError,
        failureOriginalDocumentUrl: `/documents/${job.documentId}/original`,
      });
      events.emit(`${job.documentId}:failed`, publicError);
    }
  }

  return {
    enqueue(documentId: string) {
      prune();
      if (jobs.has(documentId)) return jobs.get(documentId)!;
      const job: QueueJob = { documentId, attempts: 0, state: "queued" };
      jobs.set(documentId, job);
      queueMicrotask(() => void run(job));
      return job;
    },
    /**
     * Re-runs a finished (failed) job. Refuses to touch a job that is still
     * queued or running. Clears the dead-letter entry and the replayed event
     * history so the retried run starts fresh.
     */
    requeue(documentId: string) {
      const job = jobs.get(documentId);
      if (job && (job.state === "queued" || job.state === "running")) {
        return undefined;
      }
      jobs.delete(documentId);
      deadLetterQueue.delete(documentId);
      history.delete(documentId);
      return this.enqueue(documentId);
    },
    subscribe(documentId: string, listener: (event: StreamEvent) => void) {
      events.on(documentId, listener);
      return () => events.off(documentId, listener);
    },
    onComplete(documentId: string, listener: (plan: RecoveryPlan) => void) {
      events.on(`${documentId}:complete`, listener);
      return () => events.off(`${documentId}:complete`, listener);
    },
    onFailure(
      documentId: string,
      listener: (error: StructuredAiError) => void,
    ) {
      events.on(`${documentId}:failed`, listener);
      return () => events.off(`${documentId}:failed`, listener);
    },
    getHistory(documentId: string) {
      return history.get(documentId) ?? [];
    },
    getJob(documentId: string) {
      return jobs.get(documentId);
    },
    getDeadLetter(documentId: string) {
      return deadLetterQueue.get(documentId);
    },
    getStats() {
      let queued = 0;
      let running = 0;
      let completed = 0;
      let failed = 0;
      for (const job of jobs.values()) {
        if (job.state === "queued") queued += 1;
        else if (job.state === "running") running += 1;
        else if (job.state === "completed") completed += 1;
        else failed += 1;
      }
      return {
        queued,
        running,
        completed,
        failed,
        deadLetter: deadLetterQueue.size,
        inFlight: queued + running,
      };
    },
    listenerCount(documentId: string) {
      return (
        events.listenerCount(documentId) +
        events.listenerCount(`${documentId}:complete`) +
        events.listenerCount(`${documentId}:failed`)
      );
    },
    /** Manually prune terminal state now. Exposed for ops and tests. */
    prune,
    reset() {
      events.removeAllListeners();
      history.clear();
      jobs.clear();
      deadLetterQueue.clear();
    },
  };
}

export type PipelineQueue = ReturnType<typeof createPipelineQueue>;
export const pipelineQueue = createPipelineQueue();
