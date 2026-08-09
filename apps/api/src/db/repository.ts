import type {
  Appointment,
  Medication,
  RecoveryPlan,
} from "@discharge-guide/shared-types";
import { randomUUID } from "node:crypto";
import type {
  AccessibilityPreferences,
  AdherenceRecord,
  AuditLogRecord,
  AuthProvider,
  DatabaseState,
  DocumentRecord,
  SessionRecord,
  UserRecord,
} from "./schema.js";

const state: DatabaseState = {
  users: new Map(),
  sessions: new Map(),
  documents: new Map(),
  medications: new Map(),
  appointments: new Map(),
  adherence: [],
  preferences: new Map(),
  auditLogs: [],
};

export const repository = {
  createUser(
    email: string,
    passwordHash: string | null,
    provider: AuthProvider = "password",
  ): UserRecord {
    const user = {
      id: randomUUID(),
      email,
      passwordHash,
      provider,
      createdAt: new Date().toISOString(),
    };
    state.users.set(user.id, user);
    return user;
  },
  findUserByEmail(email: string) {
    return [...state.users.values()].find((user) => user.email === email);
  },
  findUserById(userId: string) {
    return state.users.get(userId);
  },
  deleteSessionsForUser(userId: string) {
    for (const [id, session] of state.sessions) {
      if (session.userId === userId) state.sessions.delete(id);
    }
  },
  createSession(
    userId: string,
    refreshTokenHash: string,
    expiresAt: string,
  ): SessionRecord {
    const session = {
      id: randomUUID(),
      userId,
      refreshTokenHash,
      expiresAt,
      createdAt: new Date().toISOString(),
    };
    state.sessions.set(session.id, session);
    return session;
  },
  listSessionsForUser(userId: string) {
    return [...state.sessions.values()].filter(
      (session) => session.userId === userId,
    );
  },
  deleteSession(sessionId: string) {
    state.sessions.delete(sessionId);
  },
  createDocument(document: DocumentRecord) {
    state.documents.set(document.id, document);
    return document;
  },
  findDocument(documentId: string, userId: string) {
    const document = state.documents.get(documentId);
    return document?.userId === userId ? document : undefined;
  },
  /** Internal pipeline lookup; authorization is enforced by the route before enqueue/ask. */
  findDocumentById(documentId: string) {
    return state.documents.get(documentId);
  },
  findDocumentByHash(fileHash: string, userId: string) {
    return [...state.documents.values()].find(
      (document) =>
        document.userId === userId && document.fileHash === fileHash,
    );
  },
  /** This user's documents, newest upload first. */
  listDocuments(userId: string) {
    return [...state.documents.values()]
      .filter((document) => document.userId === userId)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  },
  updateDocument(documentId: string, patch: Partial<DocumentRecord>) {
    const document = state.documents.get(documentId);
    if (!document) return undefined;
    Object.assign(document, patch);
    return document;
  },
  /** Owner-only hard delete: document, plan, medications, appointments, and adherence records. */
  deleteDocument(documentId: string, userId: string) {
    const document = state.documents.get(documentId);
    if (!document || document.userId !== userId) return undefined;
    const medicationIds = new Set(
      (document.plan?.medications ?? []).map((medication) => medication.id),
    );
    for (const medicationId of medicationIds) {
      state.medications.delete(medicationId);
    }
    for (const appointment of document.plan?.appointments ?? []) {
      state.appointments.delete(appointment.id);
    }
    state.adherence = state.adherence.filter(
      (record) =>
        record.userId !== userId || !medicationIds.has(record.medicationId),
    );
    state.documents.delete(documentId);
    return document;
  },
  savePlan(documentId: string, plan: RecoveryPlan) {
    const document = state.documents.get(documentId);
    if (!document) return;
    document.plan = plan;
    document.status = "ready";
    for (const medication of plan.medications)
      state.medications.set(medication.id, medication);
    for (const appointment of plan.appointments)
      state.appointments.set(appointment.id, appointment);
  },
  listMedications(
    documentId: string,
    userId: string,
  ): Medication[] | undefined {
    return this.findDocument(documentId, userId)?.plan?.medications;
  },
  findMedication(medicationId: string, userId: string) {
    for (const document of state.documents.values()) {
      if (document.userId !== userId) continue;
      const medication = document.plan?.medications.find(
        ({ id }) => id === medicationId,
      );
      if (medication) return medication;
    }
    return undefined;
  },
  recordTaken(
    medicationId: string,
    userId: string,
    takenAt: string,
  ): AdherenceRecord {
    const record = { id: randomUUID(), medicationId, userId, takenAt };
    state.adherence.push(record);
    return record;
  },
  listAppointments(
    documentId: string,
    userId: string,
  ): Appointment[] | undefined {
    return this.findDocument(documentId, userId)?.plan?.appointments;
  },
  findAppointment(appointmentId: string, userId: string) {
    for (const document of state.documents.values()) {
      if (document.userId !== userId) continue;
      const appointment = document.plan?.appointments.find(
        ({ id }) => id === appointmentId,
      );
      if (appointment) return appointment;
    }
    return undefined;
  },
  getPreferences(userId: string) {
    return state.preferences.get(userId);
  },
  setPreferences(userId: string, preferences: AccessibilityPreferences) {
    state.preferences.set(userId, preferences);
    return preferences;
  },
  recordAudit(log: Omit<AuditLogRecord, "id">) {
    const record = { id: randomUUID(), ...log };
    state.auditLogs.push(record);
    return record;
  },
  reset() {
    state.users.clear();
    state.sessions.clear();
    state.documents.clear();
    state.medications.clear();
    state.appointments.clear();
    state.adherence.length = 0;
    state.preferences.clear();
    state.auditLogs.length = 0;
  },
  inspect: () => state,
};
