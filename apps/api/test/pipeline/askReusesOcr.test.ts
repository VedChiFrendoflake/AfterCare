import { beforeEach, describe, it, expect, vi } from "vitest";

const { callJsonMock, runOcrMock, loadDocumentMock } = vi.hoisted(() => ({
  callJsonMock: vi.fn(),
  runOcrMock: vi.fn(),
  loadDocumentMock: vi.fn(),
}));
vi.mock("../../src/integrations/openai.js", () => ({ callJson: callJsonMock }));
vi.mock("../../src/pipeline/ocr.js", () => ({ runOcr: runOcrMock }));
vi.mock("../../src/integrations/storage.js", () => ({
  loadDocument: loadDocumentMock,
  storageStatus: () => ({ configured: false, mode: "memory" }),
}));

import { askGrounded } from "../../src/pipeline/ask.js";
import { repository } from "../../src/db/repository.js";
import { resetOcrCache } from "../../src/cache/index.js";
import type { OcrResult } from "../../src/pipeline/types.js";

const randomId = () => globalThis.crypto.randomUUID();

const storedOcr: OcrResult = {
  lines: [
    { line: 1, text: "Take Lisinopril 10mg once daily in the morning.", confidence: 99 },
    { line: 2, text: "Go to the ER if you have chest pain.", confidence: 99 },
  ],
  text: "Take Lisinopril 10mg once daily in the morning.\nGo to the ER if you have chest pain.",
  pageCount: 1,
};

function seedDocument(ocr?: OcrResult) {
  const user = repository.createUser("patient@example.com", "hash");
  const doc = {
    id: randomId(),
    userId: user.id,
    filename: "discharge.pdf",
    mimeType: "application/pdf",
    fileHash: `hash-${randomId()}`,
    storageKey: `users/${user.id}/documents/d.enc`,
    uploadedAt: new Date().toISOString(),
    status: "ready" as const,
    ...(ocr ? { ocr } : {}),
  };
  repository.createDocument(doc);
  return { user, doc };
}

beforeEach(() => {
  vi.resetAllMocks();
  repository.reset();
  resetOcrCache();
});

/**
 * /ask used to reload the file and transcribe it again for every question.
 * For an image that meant a fresh vision call each time, and any failure in
 * that second pass was reported as an AI outage even though no provider had
 * been contacted — which is exactly what made it look like an AI problem.
 */
describe("askGrounded reuses the pipeline's transcription", () => {
  it("answers from the stored OCR without touching storage or OCR again", async () => {
    const { doc } = seedDocument(storedOcr);
    callJsonMock.mockResolvedValue({
      answer: "Take it in the morning.",
      confidence: 90,
      sourceLines: [1],
      source: "document",
    });

    const result = await askGrounded({
      documentId: doc.id,
      question: "When do I take it?",
    });

    expect(loadDocumentMock).not.toHaveBeenCalled();
    expect(runOcrMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ answer: "Take it in the morning." });
  });

  it("still grounds the answer against the stored lines", async () => {
    const { doc } = seedDocument(storedOcr);
    // Cites a line that does not exist in the document.
    callJsonMock.mockResolvedValue({
      answer: "Invented.",
      confidence: 95,
      sourceLines: [99],
      source: "document",
    });

    const result = await askGrounded({
      documentId: doc.id,
      question: "When do I take it?",
    });

    // The citation is dropped and the claim demoted, exactly as when the OCR
    // came from a fresh pass — reusing the transcription must not weaken this.
    expect(result).toMatchObject({ source: { sourceLines: [] } });
  });

  it("falls back to a fresh pass for a document stored before this existed", async () => {
    const { doc } = seedDocument(); // no ocr on the record
    loadDocumentMock.mockResolvedValue(Buffer.from("pdf"));
    runOcrMock.mockResolvedValue({
      success: true,
      data: storedOcr,
      confidence: 90,
      sourceLines: [],
    });
    callJsonMock.mockResolvedValue({
      answer: "From a fresh pass.",
      confidence: 80,
      sourceLines: [1],
      source: "document",
    });

    const result = await askGrounded({
      documentId: doc.id,
      question: "When do I take it?",
    });

    expect(loadDocumentMock).toHaveBeenCalled();
    expect(runOcrMock).toHaveBeenCalled();
    expect(result).toMatchObject({ answer: "From a fresh pass." });
  });

  it("does not use an empty transcription", async () => {
    // An OCR result with no lines is not usable; fall through rather than ask
    // the model to answer from nothing.
    const { doc } = seedDocument({ lines: [], text: "", pageCount: 0 });
    loadDocumentMock.mockResolvedValue(Buffer.from("pdf"));
    runOcrMock.mockResolvedValue({
      success: true,
      data: storedOcr,
      confidence: 90,
      sourceLines: [],
    });
    callJsonMock.mockResolvedValue({
      answer: "Recovered.",
      confidence: 80,
      sourceLines: [1],
      source: "document",
    });

    await askGrounded({ documentId: doc.id, question: "When?" });

    expect(runOcrMock).toHaveBeenCalled();
  });
});
