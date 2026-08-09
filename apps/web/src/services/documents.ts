/**
 * One document API for the whole app, routing to whichever backing service is
 * available. Screens never branch on mode themselves.
 *
 *   backend  — bytes + AI pipeline live on the API; a local index tracks which
 *              documentIds belong to this browser (the API has no list endpoint).
 *   firebase — Firestore documents + Storage uploads.
 *   local    — IndexedDB bytes + localStorage metadata. Always available.
 */

import { currentMode, detectMode } from "./config";
import * as local from "./localStore";
import {
  backendUpload,
  originalDocumentUrl,
  planToRecoveryData,
  streamProcess,
} from "./backend";
import { markFinished, recordStageEvent } from "./processingProgress";
import type { AppUser } from "./session";
import type { RecoveryData, UploadedDocument } from "../types";

// These mirror the API's own limits (apps/api/src/routes/upload.ts). They used
// to be more generous than the server, so a HEIC photo or a 16MB scan passed
// validation here and was then rejected on upload — the failure surfaced far
// from the cause and looked like "upload is broken".
//
// HEIC is excluded on purpose rather than as an oversight: vision transcription
// can't read it. Leaving it out of `accept` also makes Safari convert an iPhone
// photo to JPEG on the way in, which is what we want anyway.
const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPTED = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];
const ACCEPTED_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];

export function validateFile(file: File): void {
  const name = file.name.toLowerCase();
  const ok = ACCEPTED.includes(file.type) || ACCEPTED_EXT.some((e) => name.endsWith(e));
  if (!ok) throw new Error("Please choose a PDF or a photo (JPG, PNG, or WebP).");
  if (file.size > MAX_BYTES) {
    throw new Error("That file is over 15MB. Try a smaller scan or a lower-resolution photo.");
  }
}

/* ------------------------------ watching ------------------------------ */

export function watchDocuments(
  user: AppUser,
  cb: (docs: UploadedDocument[]) => void,
  onError: (message: string) => void
): () => void {
  const mode = currentMode();

  if (mode === "firebase" && !user.isLocal) {
    let cancelled = false;
    let inner: (() => void) | undefined;
    import("./firestore")
      .then(({ watchUserDocuments }) => {
        if (cancelled) return;
        inner = watchUserDocuments(user.uid, cb, (e) => onError(e.message));
      })
      .catch(() => onError("Couldn't load your documents."));
    return () => {
      cancelled = true;
      inner?.();
    };
  }

  cb(local.listDocuments());
  return local.subscribeLocal(() => cb(local.listDocuments()));
}

export function watchRecovery(
  user: AppUser,
  documentId: string | undefined,
  cb: (data: RecoveryData | null) => void,
  onError: (message: string) => void
): () => void {
  if (!documentId) {
    cb(null);
    return () => {};
  }
  const mode = currentMode();

  if (mode === "firebase" && !user.isLocal) {
    let cancelled = false;
    let inner: (() => void) | undefined;
    import("./firestore")
      .then(({ watchRecoveryData }) => {
        if (cancelled) return;
        inner = watchRecoveryData(user.uid, documentId, cb, (e) => onError(e.message));
      })
      .catch(() => onError("Couldn't load your recovery guide."));
    return () => {
      cancelled = true;
      inner?.();
    };
  }

  cb(local.getRecovery(documentId));
  return local.subscribeLocal(() => cb(local.getRecovery(documentId)));
}

/* ------------------------------ uploading ----------------------------- */

export interface UploadOutcome {
  documentId: string;
  /** True when the backend accepted it and processing has begun. */
  processing: boolean;
}

export async function uploadDocument(
  user: AppUser,
  file: File,
  onProgress: (pct: number) => void
): Promise<UploadOutcome> {
  validateFile(file);
  // Await detection rather than reading currentMode()'s synchronous guess: on a
  // first load that guess is "local" until the health probe returns, and an
  // upload that lands a millisecond early was silently written to the device
  // instead of sent to the API, with no error and no retry.
  const mode = await detectMode();
  const now = Date.now();

  if (mode === "backend" && !user.isLocal) {
    onProgress(10);
    const result = await backendUpload(file);
    onProgress(100);
    local.saveDocument({
      id: result.documentId,
      ownerUid: user.uid,
      fileName: file.name,
      source: "upload",
      status: "processing",
      createdAt: now,
      updatedAt: now,
    });
    watchProcessing(result.documentId);
    return { documentId: result.documentId, processing: true };
  }

  if (mode === "firebase" && !user.isLocal) {
    const { uploadDischargeFile } = await import("./storage");
    const { createUploadedDocumentRecord } = await import("./firestore");
    const { promise } = uploadDischargeFile(user.uid, file, onProgress);
    const { storagePath } = await promise;
    const documentId = await createUploadedDocumentRecord({
      uid: user.uid,
      fileName: file.name,
      source: "upload",
      storagePath,
    });
    return { documentId, processing: false };
  }

  // Local mode — keep the bytes in this browser.
  const documentId = crypto.randomUUID();
  onProgress(30);
  await local.putFile(documentId, file);
  onProgress(100);
  local.saveDocument({
    id: documentId,
    ownerUid: user.uid,
    fileName: file.name,
    source: "upload",
    status: "uploaded",
    createdAt: now,
    updatedAt: now,
  });
  return { documentId, processing: false };
}

/** Subscribes to backend pipeline events and mirrors them into the local index. */
export function watchProcessing(documentId: string): () => void {
  if (currentMode() !== "backend") return () => {};

  return streamProcess(documentId, {
    onEvent: (event) => {
      local.updateDocument(documentId, { status: "processing" });
      recordStageEvent(documentId, event.stage, event.status);
    },
    onComplete: (plan) => {
      markFinished(documentId);
      local.saveRecovery(planToRecoveryData(plan));
      local.updateDocument(documentId, { status: "ready" });
    },
    onFailed: (message) => local.updateDocument(documentId, { status: "error", errorMessage: message }),
  });
}

/** URL or object URL for viewing the original upload. Caller revokes object URLs. */
export async function originalDocumentSrc(documentId: string): Promise<string | null> {
  if (currentMode() === "backend") return originalDocumentUrl(documentId);
  const blob = await local.getFile(documentId).catch(() => null);
  return blob ? URL.createObjectURL(blob) : null;
}
