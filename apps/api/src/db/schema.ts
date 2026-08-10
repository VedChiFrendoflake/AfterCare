import type {
  Appointment,
  Medication,
  RecoveryPlan,
  StructuredAiError,
} from "@discharge-guide/shared-types";
import type { OcrResult } from "../pipeline/types.js";

export type AuthProvider = "password" | "google";

/**
 * A clinician is an ordinary account with a different role, not a separate
 * table. The role alone grants nothing: reading a patient's records requires an
 * approved CareLinkRecord, which only the patient can create by approving.
 */
export type UserRole = "patient" | "clinician";

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  /** Shown to a patient deciding whether to approve a request. */
  displayName?: string;
  /**
   * Null for accounts created through Google, which have no password to
   * compare against. Modelled explicitly rather than storing an unmatchable
   * placeholder hash, so /login can refuse them with a useful message instead
   * of a generic "email or password is incorrect".
   */
  passwordHash: string | null;
  provider: AuthProvider;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  fileHash: string;
  storageKey: string;
  uploadedAt: string;
  status: "uploaded" | "processing" | "ready" | "failed";
  failure?: StructuredAiError;
  failureOriginalDocumentUrl?: string;
  plan?: RecoveryPlan;
  /**
   * The transcription the pipeline already produced.
   *
   * Kept so /ask can answer from it instead of reloading the file and running
   * OCR a second time. That second pass was both the slow path and a failure
   * path: for an image it re-ran vision transcription on every question, and
   * when it failed the result was reported as an AI outage even though no
   * provider had been contacted.
   */
  ocr?: OcrResult;
}

export interface AccessibilityPreferences {
  textSize: "large" | "very_large";
  darkMode: boolean;
  highContrast: boolean;
  reduceMotion: boolean;
  voiceReading: boolean;
}

export interface AuditLogRecord {
  id: string;
  userId?: string;
  action: string;
  resource: string;
  timestamp: string;
  ipAddress: string;
  statusCode: number;
}

export interface AdherenceRecord {
  id: string;
  medicationId: string;
  userId: string;
  takenAt: string;
}

/**
 * A clinician's access to one patient.
 *
 * `pending` is the only state a clinician can create. Nothing is readable until
 * the patient moves it to `approved`, and either side can end it — the patient
 * by revoking, which is the state that matters. Denied and revoked links are
 * kept rather than deleted so the audit trail survives.
 */
export type CareLinkStatus = "pending" | "approved" | "denied" | "revoked";

export interface CareLinkRecord {
  id: string;
  clinicianId: string;
  patientId: string;
  status: CareLinkStatus;
  /** Free text from the requester, shown to the patient with the request. */
  reason?: string;
  requestedAt: string;
  respondedAt?: string;
}

/**
 * A red-flag symptom the patient reported, raised to their care circle.
 *
 * These are records, not deliveries — nothing here claims to have sent mail.
 * A linked clinician sees them in their feed; the patient is told plainly who
 * can see it. Same honesty the caregiver alerts already follow.
 */
export interface CareAlertRecord {
  id: string;
  patientId: string;
  documentId?: string;
  /** Verbatim symptom text as shown to the patient. */
  symptoms: string[];
  action: string;
  severity: "call-doctor" | "emergency";
  note?: string;
  createdAt: string;
  /** Clinician ids that have opened it. */
  readBy: string[];
}

export interface DatabaseState {
  users: Map<string, UserRecord>;
  sessions: Map<string, SessionRecord>;
  documents: Map<string, DocumentRecord>;
  medications: Map<string, Medication>;
  appointments: Map<string, Appointment>;
  adherence: AdherenceRecord[];
  preferences: Map<string, AccessibilityPreferences>;
  auditLogs: AuditLogRecord[];
  careLinks: Map<string, CareLinkRecord>;
  careAlerts: Map<string, CareAlertRecord>;
}
