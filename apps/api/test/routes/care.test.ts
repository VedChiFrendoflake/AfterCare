import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { repository } from "../../src/db/repository.js";
import { resetStorage } from "../../src/integrations/storage.js";

const app = createApp();

afterEach(() => {
  repository.reset();
  resetStorage();
});

async function signUp(
  email: string,
  role: "patient" | "clinician",
  displayName?: string,
) {
  const response = await request(app)
    .post("/auth/register")
    .send({ email, password: "a-safe-password-123", role, displayName })
    .expect(201);
  return {
    token: response.body.accessToken as string,
    id: response.body.user.id as string,
    body: response.body,
  };
}

function givePlan(patientId: string, documentId = "doc-1") {
  repository.createDocument({
    id: documentId,
    userId: patientId,
    filename: "discharge.pdf",
    mimeType: "application/pdf",
    fileHash: `hash-${documentId}`,
    storageKey: `key-${documentId}`,
    uploadedAt: new Date().toISOString(),
    status: "ready",
  });
  repository.savePlan(documentId, {
    documentId,
    status: "ready",
    disclaimer: "d",
    isPlaceholder: false,
    medications: [],
    appointments: [],
    warnings: [],
    timeline: [],
  } as never);
  return documentId;
}

/** Drives the full request -> approve handshake and returns both tokens. */
async function linkedPair() {
  const patient = await signUp("patient@example.com", "patient");
  const clinician = await signUp("dr@example.com", "clinician", "Dr. Chen");

  await request(app)
    .post("/care/requests")
    .set("Authorization", `Bearer ${clinician.token}`)
    .send({ patientEmail: "patient@example.com" })
    .expect(202);

  const pending = await request(app)
    .get("/care/requests")
    .set("Authorization", `Bearer ${patient.token}`)
    .expect(200);
  const linkId = pending.body.data[0].id as string;

  await request(app)
    .post(`/care/requests/${linkId}/approve`)
    .set("Authorization", `Bearer ${patient.token}`)
    .expect(200);

  return { patient, clinician, linkId };
}

describe("care links", () => {
  it("registers clinician accounts with their role", async () => {
    const clinician = await signUp("dr@example.com", "clinician", "Dr. Chen");
    expect(clinician.body.user.role).toBe("clinician");
    expect(clinician.body.user.displayName).toBe("Dr. Chen");
  });

  it("defaults an account to patient when no role is asked for", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({ email: "someone@example.com", password: "a-safe-password-123" })
      .expect(201);
    expect(response.body.user.role).toBe("patient");
  });

  it("runs request -> approve -> read", async () => {
    const { patient, clinician } = await linkedPair();
    givePlan(patient.id);

    const response = await request(app)
      .get(`/care/patients/${patient.id}/plan`)
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(200);

    expect(response.body.patient.email).toBe("patient@example.com");
    expect(response.body.plan).not.toBeNull();
  });

  /* -------------------- the boundary this file exists for ------------------- */

  it("refuses a clinician who has only requested, not been approved", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const clinician = await signUp("dr@example.com", "clinician");
    givePlan(patient.id);

    await request(app)
      .post("/care/requests")
      .set("Authorization", `Bearer ${clinician.token}`)
      .send({ patientEmail: "patient@example.com" })
      .expect(202);

    await request(app)
      .get(`/care/patients/${patient.id}/plan`)
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(404);
  });

  it("refuses a clinician with no link at all", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const stranger = await signUp("stranger@example.com", "clinician");
    givePlan(patient.id);

    await request(app)
      .get(`/care/patients/${patient.id}/plan`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(404);
  });

  it("stops reading the moment the patient revokes", async () => {
    const { patient, clinician, linkId } = await linkedPair();
    givePlan(patient.id);

    await request(app)
      .get(`/care/patients/${patient.id}/plan`)
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(200);

    await request(app)
      .post(`/care/links/${linkId}/revoke`)
      .set("Authorization", `Bearer ${patient.token}`)
      .expect(200);

    await request(app)
      .get(`/care/patients/${patient.id}/plan`)
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(404);
  });

  it("refuses a denied request", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const clinician = await signUp("dr@example.com", "clinician");
    givePlan(patient.id);

    await request(app)
      .post("/care/requests")
      .set("Authorization", `Bearer ${clinician.token}`)
      .send({ patientEmail: "patient@example.com" })
      .expect(202);
    const pending = await request(app)
      .get("/care/requests")
      .set("Authorization", `Bearer ${patient.token}`)
      .expect(200);
    await request(app)
      .post(`/care/requests/${pending.body.data[0].id}/deny`)
      .set("Authorization", `Bearer ${patient.token}`)
      .expect(200);

    await request(app)
      .get(`/care/patients/${patient.id}/plan`)
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(404);
  });

  it("does not let a different patient answer someone else's request", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const bystander = await signUp("other@example.com", "patient");
    const clinician = await signUp("dr@example.com", "clinician");

    await request(app)
      .post("/care/requests")
      .set("Authorization", `Bearer ${clinician.token}`)
      .send({ patientEmail: "patient@example.com" })
      .expect(202);
    const pending = await request(app)
      .get("/care/requests")
      .set("Authorization", `Bearer ${patient.token}`)
      .expect(200);

    await request(app)
      .post(`/care/requests/${pending.body.data[0].id}/approve`)
      .set("Authorization", `Bearer ${bystander.token}`)
      .expect(404);
  });

  it("does not let a patient grant themselves clinician powers", async () => {
    const patient = await signUp("patient@example.com", "patient");
    await request(app)
      .post("/care/requests")
      .set("Authorization", `Bearer ${patient.token}`)
      .send({ patientEmail: "someone@example.com" })
      .expect(403);
  });

  it("answers identically for a real and an unknown address", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const clinician = await signUp("dr@example.com", "clinician");

    const real = await request(app)
      .post("/care/requests")
      .set("Authorization", `Bearer ${clinician.token}`)
      .send({ patientEmail: "patient@example.com" });
    const fake = await request(app)
      .post("/care/requests")
      .set("Authorization", `Bearer ${clinician.token}`)
      .send({ patientEmail: "nobody@example.com" });

    // Otherwise this endpoint reports whether a given person is a patient here.
    expect(real.status).toBe(fake.status);
    expect(real.body).toEqual(fake.body);
    expect(patient.id).toBeTruthy();
  });
});

describe("care alerts", () => {
  it("reaches an approved clinician's feed", async () => {
    const { patient, clinician } = await linkedPair();

    const raised = await request(app)
      .post("/care/alerts")
      .set("Authorization", `Bearer ${patient.token}`)
      .send({
        symptoms: ["chest pain"],
        action: "Go to the emergency room",
        severity: "emergency",
      })
      .expect(201);

    expect(raised.body.visibleTo).toEqual(["dr@example.com"]);
    // Never claims delivery: there is no mail infrastructure behind this.
    expect(raised.body.delivered).toBe(false);

    const feed = await request(app)
      .get("/care/alerts")
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(200);
    expect(feed.body.data).toHaveLength(1);
    expect(feed.body.data[0].symptoms).toEqual(["chest pain"]);
    expect(feed.body.data[0].read).toBe(false);
  });

  it("says plainly when nobody can see it", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const raised = await request(app)
      .post("/care/alerts")
      .set("Authorization", `Bearer ${patient.token}`)
      .send({ symptoms: ["fever"], action: "Call your doctor", severity: "call-doctor" })
      .expect(201);

    expect(raised.body.visibleTo).toEqual([]);
    expect(raised.body.message).toContain("nobody has been notified");
  });

  it("keeps alerts away from unlinked clinicians", async () => {
    const patient = await signUp("patient@example.com", "patient");
    const stranger = await signUp("stranger@example.com", "clinician");

    await request(app)
      .post("/care/alerts")
      .set("Authorization", `Bearer ${patient.token}`)
      .send({ symptoms: ["chest pain"], action: "ER", severity: "emergency" })
      .expect(201);

    const feed = await request(app)
      .get("/care/alerts")
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(200);
    expect(feed.body.data).toEqual([]);
  });

  it("drops out of the feed when access is revoked", async () => {
    const { patient, clinician, linkId } = await linkedPair();
    await request(app)
      .post("/care/alerts")
      .set("Authorization", `Bearer ${patient.token}`)
      .send({ symptoms: ["chest pain"], action: "ER", severity: "emergency" })
      .expect(201);

    await request(app)
      .post(`/care/links/${linkId}/revoke`)
      .set("Authorization", `Bearer ${patient.token}`)
      .expect(200);

    const feed = await request(app)
      .get("/care/alerts")
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(200);
    expect(feed.body.data).toEqual([]);
  });

  it("marks an alert read", async () => {
    const { patient, clinician } = await linkedPair();
    await request(app)
      .post("/care/alerts")
      .set("Authorization", `Bearer ${patient.token}`)
      .send({ symptoms: ["chest pain"], action: "ER", severity: "emergency" })
      .expect(201);

    const feed = await request(app)
      .get("/care/alerts")
      .set("Authorization", `Bearer ${clinician.token}`);
    await request(app)
      .post(`/care/alerts/${feed.body.data[0].id}/read`)
      .set("Authorization", `Bearer ${clinician.token}`)
      .expect(200);

    const after = await request(app)
      .get("/care/alerts")
      .set("Authorization", `Bearer ${clinician.token}`);
    expect(after.body.data[0].read).toBe(true);
  });

  it("requires authentication", async () => {
    await request(app).get("/care/alerts").expect(401);
    await request(app).get("/care/requests").expect(401);
  });
});
