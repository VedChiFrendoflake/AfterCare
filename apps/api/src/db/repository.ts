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
  CareAlertRecord,
  CareLinkRecord,
  CareLinkStatus,
  DatabaseState,
  DocumentRecord,
  SessionRecord,
  UserRecord,
  UserRole,
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
  careLinks: new Map(),
  careAlerts: new Map(),
};

export const repository = {
  createUser(
    email: string,
    passwordHash: string | null,
    provider: AuthProvider = "password",
    role: UserRole = "patient",
    displayName?: string,
  ): UserRecord {
    const user = {
      id: randomUUID(),
      email,
      role,
      displayName,
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
  /* ------------------------------- care links ------------------------------ */

  createCareLink(clinicianId: string, patientId: string, reason?: string) {
    const link: CareLinkRecord = {
      id: randomUUID(),
      clinicianId,
      patientId,
      status: "pending",
      reason,
      requestedAt: new Date().toISOString(),
    };
    state.careLinks.set(link.id, link);
    return link;
  },
  findCareLink(linkId: string) {
    return state.careLinks.get(linkId);
  },
  /** An existing request or grant between this pair, whatever its state. */
  findCareLinkBetween(clinicianId: string, patientId: string) {
    return [...state.careLinks.values()].find(
      (link) => link.clinicianId === clinicianId && link.patientId === patientId,
    );
  },
  setCareLinkStatus(linkId: string, status: CareLinkStatus) {
    const link = state.careLinks.get(linkId);
    if (!link) return undefined;
    link.status = status;
    link.respondedAt = new Date().toISOString();
    return link;
  },
  listCareLinksForPatient(patientId: string) {
    return [...state.careLinks.values()]
      .filter((link) => link.patientId === patientId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  },
  listCareLinksForClinician(clinicianId: string) {
    return [...state.careLinks.values()]
      .filter((link) => link.clinicianId === clinicianId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  },
  /**
   * The single question every clinician-facing read must ask. Anything other
   * than an approved link — pending, denied, revoked, absent — is a no.
   */
  clinicianCanRead(clinicianId: string, patientId: string): boolean {
    const link = this.findCareLinkBetween(clinicianId, patientId);
    return link?.status === "approved";
  },

  /* --------------------------------- alerts -------------------------------- */

  createCareAlert(
    alert: Omit<CareAlertRecord, "id" | "createdAt" | "readBy">,
  ): CareAlertRecord {
    const record: CareAlertRecord = {
      ...alert,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      readBy: [],
    };
    state.careAlerts.set(record.id, record);
    return record;
  },
  listAlertsForPatient(patientId: string) {
    return [...state.careAlerts.values()]
      .filter((alert) => alert.patientId === patientId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  /** Only alerts from patients who have approved this clinician. */
  listAlertsForClinician(clinicianId: string) {
    const patientIds = new Set(
      [...state.careLinks.values()]
        .filter(
          (link) => link.clinicianId === clinicianId && link.status === "approved",
        )
        .map((link) => link.patientId),
    );
    return [...state.careAlerts.values()]
      .filter((alert) => patientIds.has(alert.patientId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  markAlertRead(alertId: string, clinicianId: string) {
    const alert = state.careAlerts.get(alertId);
    if (!alert) return undefined;
    if (!alert.readBy.includes(clinicianId)) alert.readBy.push(clinicianId);
    return alert;
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
    state.careLinks.clear();
    state.careAlerts.clear();
  },
  inspect: () => state,
};
