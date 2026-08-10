/**
 * Grounded Q&A. This is the function Person B's `POST /ask` route calls ?
 * it lives in pipeline/, not routes/, per the backend split (Person A owns
 * no Express code).
 */
import type {
  AiFunctionResult,
  AskGroundedInput,
  AskGroundedResult,
} from "@discharge-guide/shared-types";
import type { GroundedAnswer, OcrResult } from "./types.js";
import { cacheOcr, ocrCacheKey } from "../cache/index.js";
import { repository } from "../db/repository.js";
import { AppError } from "../errors.js";
import { loadDocument } from "../integrations/storage.js";
import { callJson } from "../integrations/openai.js";
import {
  CONFIDENCE_THRESHOLD,
  isGrounded,
  resolveSourceLines,
} from "./grounding.js";
import { runOcr } from "./ocr.js";

const SYSTEM_PROMPT = `You answer a patient's question about their hospital discharge document.
You are given the numbered-line text of that document. Rules:
1. If the document answers the question, answer from it ONLY and cite the
   exact line numbers you used.
2. If the document does NOT cover it, you may give brief, general health
   education ? but you MUST say explicitly that this is general information,
   not from their specific document, and they should confirm with their
   care team. Set source to "general" and sourceLines to [].
3. If you cannot safely answer at all (e.g. it requires clinical judgment
   you don't have), set source to "not-found" and say so plainly.
Never invent information and never alter or contradict a dosage, schedule,
or instruction found in the document.`;

const SCHEMA_HINT = `{
  "answer": string,
  "confidence": number,
  "sourceLines": number[],
  "source": "document" | "general" | "not-found"
}`;

const VALID_SOURCES: GroundedAnswer["source"][] = [
  "document",
  "general",
  "not-found",
];

async function askFromOcr(
  question: string,
  ocr: OcrResult,
): Promise<GroundedAnswer> {
  const validLines = new Set(ocr.lines.map((l) => l.line));
  const numberedText = ocr.lines.map((l) => `${l.line}: ${l.text}`).join("\n");
  const user = `Document:\n${numberedText}\n\nQuestion: ${question}`;

  const raw = await callJson<Partial<GroundedAnswer>>({
    system: SYSTEM_PROMPT,
    user,
    schemaHint: SCHEMA_HINT,
  });

  const answer: GroundedAnswer = {
    answer: raw.answer ?? "",
    confidence: raw.confidence ?? 0,
    source: VALID_SOURCES.includes(raw.source as GroundedAnswer["source"])
      ? raw.source!
      : "not-found",
    // Drop any cited line that doesn't actually exist, regardless of source.
    sourceLines: Array.isArray(raw.sourceLines)
      ? raw.sourceLines.filter((n) => validLines.has(n))
      : [],
  };

  // Defense in depth: don't trust the model's own grounding claim ? verify
  // the cited lines actually exist before honoring a "document" source.
  if (
    answer.source === "document" &&
    !isGrounded(ocr.lines, answer.sourceLines)
  ) {
    return {
      answer: answer.answer,
      confidence: Math.min(answer.confidence, CONFIDENCE_THRESHOLD - 1),
      sourceLines: [],
      source: "general",
    };
  }

  return answer;
}

export function askGrounded(
  input: AskGroundedInput,
): Promise<AiFunctionResult<AskGroundedResult>>;
export function askGrounded(
  question: string,
  ocr: OcrResult,
): Promise<GroundedAnswer>;
export async function askGrounded(
  inputOrQuestion: AskGroundedInput | string,
  suppliedOcr?: OcrResult,
): Promise<AiFunctionResult<AskGroundedResult> | GroundedAnswer> {
  if (typeof inputOrQuestion === "string") {
    if (!suppliedOcr) throw new Error("OCR input is required");
    return askFromOcr(inputOrQuestion, suppliedOcr);
  }

  const document = repository.findDocumentById(inputOrQuestion.documentId);
  if (!document) {
    return {
      code: "AI_VALIDATION_FAILED",
      message: "The request could not be processed safely.",
      retryable: false,
    };
  }
  // The pipeline already transcribed this document, and the queue keeps that
  // result. Answering from it is both faster and safer than transcribing
  // again: the second pass re-ran vision on every question for an image, and
  // any failure in it surfaced as an AI outage even though no provider had
  // been contacted. Falling back to a fresh pass keeps documents that predate
  // this working.
  if (document.ocr && document.ocr.lines.length > 0) {
    const answer = await askFromOcr(inputOrQuestion.question, document.ocr);
    return {
      answer: answer.answer,
      confidence: answer.confidence,
      source: {
        documentId: inputOrQuestion.documentId,
        sourceLines: answer.sourceLines,
      },
    };
  }

  // Re-using the document's file hash keeps repeat questions on the same
  // document from re-running OCR (expensive for scanned PDFs). The storage
  // read stays inside the compute callback so a cache hit skips it too.
  // Only successful OCR results are cached, so transient failures retry.
  let ocr;
  try {
    ocr = await cacheOcr(
      ocrCacheKey(document.fileHash),
      async () =>
        runOcr({
          buffer: await loadDocument(document.storageKey),
          mimeType: document.mimeType,
        }),
      (result) => result.success === true,
    );
  } catch (error) {
    // The stored bytes are gone — typically an instance restart while storage
    // is in memory (S3 unconfigured). Reporting this as a temporary AI outage
    // sends the patient into an endless "try again" loop for something no
    // amount of retrying can fix, so it is surfaced as its own condition.
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      throw new AppError(
        410,
        "We no longer have a readable copy of that document. Please upload it again.",
        "DOCUMENT_UNAVAILABLE",
      );
    }
    throw error;
  }

  if (!ocr.success || !ocr.data) {
    return {
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI processing is temporarily unavailable.",
      retryable: true,
    };
  }

  const answer = await askFromOcr(inputOrQuestion.question, ocr.data);
  return {
    answer: answer.answer,
    confidence: answer.confidence,
    source: {
      documentId: inputOrQuestion.documentId,
      sourceLines: answer.sourceLines,
    },
  };
}

/** Convenience: the resolved text behind an answer's citations, for UI "show source" links. */
export function citedText(ocr: OcrResult, answer: GroundedAnswer): string {
  return resolveSourceLines(ocr.lines, answer.sourceLines);
}
