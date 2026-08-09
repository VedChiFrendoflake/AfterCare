import { Router } from "express";
import { repository } from "../db/repository.js";
import { deleteStoredDocument, loadDocument } from "../integrations/storage.js";

export const documentsRouter = Router();

/**
 * The user's own documents, newest first. Deliberately metadata only — never
 * the stored bytes and never the extracted plan, which have their own routes
 * and their own ownership checks.
 */
documentsRouter.get("/", (req, res, next) => {
  try {
    const documents = repository.listDocuments(req.userId!).map((document) => ({
      id: document.id,
      filename: document.filename,
      mimeType: document.mimeType,
      uploadedAt: document.uploadedAt,
      status: document.status,
      ...(document.failure ? { failure: document.failure } : {}),
    }));
    res.json({ data: documents });
  } catch (error) {
    next(error);
  }
});

documentsRouter.get("/:documentId/original", async (req, res, next) => {
  try {
    const document = repository.findDocument(
      req.params.documentId,
      req.userId!,
    );
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const bytes = await loadDocument(document.storageKey);
    res.type(document.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
    );
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

documentsRouter.delete("/:documentId", async (req, res, next) => {
  try {
    const document = repository.findDocument(
      req.params.documentId,
      req.userId!,
    );
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await deleteStoredDocument(document.storageKey);
    repository.deleteDocument(document.id, req.userId!);
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});
