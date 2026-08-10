import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { repository } from "../db/repository.js";
import { AppError } from "../errors.js";

/**
 * Clinician access to patient records, and the alert feed built on top of it.
 *
 * The rule this file exists to enforce: a clinician account grants nothing on
 * its own. Every read of patient data goes through `requireApprovedLink`, which
 * only passes on a link the patient themselves approved. A clinician may
 * request; only a patient may grant, and only a patient may revoke.
 *
 * Requests are matched by email, which means an existing address can be probed
 * for. That is why the request endpoint answers identically whether or not the
 * address belongs to a real account — see the comment on POST /requests.
 */

const requestSchema = z.object({
  patientEmail: z.string().email(),
  reason: z.string().max(300).optional(),
});

const alertSchema = z.object({
  documentId: z.string().optional(),
  symptoms: z.array(z.string().max(300)).min(1).max(20),
  action: z.string().max(200),
  severity: z.enum(["call-doctor", "emergency"]),
  note: z.string().max(500).optional(),
});

function requireRole(userId: string, role: "patient" | "clinician") {
  const user = repository.findUserById(userId);
  if (!user) throw new AppError(401, "Authentication required", "UNAUTHORIZED");
  if (user.role !== role) {
    throw new AppError(
      403,
      role === "clinician"
        ? "This action is for clinician accounts."
        : "This action is for patient accounts.",
      "WRONG_ROLE",
    );
  }
  return user;
}

/** The only door onto another person's records. */
function requireApprovedLink(clinicianId: string, patientId: string) {
  if (!repository.clinicianCanRead(clinicianId, patientId)) {
    // Deliberately 404 rather than 403: a clinician without an approved link
    // should not be able to confirm that a given patient id exists.
    throw new AppError(404, "Patient not found", "NOT_FOUND");
  }
}

function publicUser(userId: string) {
  const user = repository.findUserById(userId);
  return user
    ? { id: user.id, email: user.email, displayName: user.displayName }
    : undefined;
}

export function createCareRouter() {
  const router = Router();

  /* ------------------------------- requests ------------------------------- */

  router.post("/requests", (req, res, next) => {
    try {
      const clinician = requireRole(req.userId!, "clinician");
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A valid patient email is required." });
        return;
      }

      const patient = repository.findUserByEmail(parsed.data.patientEmail);

      // Same response either way. Answering "no such patient" would turn this
      // endpoint into a way of testing whether someone has an account here,
      // which for a medical service is itself disclosure.
      const accepted = {
        status: "requested",
        message:
          "If that address belongs to an AfterCare patient, they'll see your request next time they sign in.",
      };

      if (!patient || patient.role !== "patient") {
        res.status(202).json(accepted);
        return;
      }

      const existing = repository.findCareLinkBetween(clinician.id, patient.id);
      if (existing?.status === "approved" || existing?.status === "pending") {
        res.status(202).json(accepted);
        return;
      }

      repository.createCareLink(clinician.id, patient.id, parsed.data.reason);
      repository.recordAudit({
        userId: clinician.id,
        action: "care.request",
        resource: `patient:${patient.id}`,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip ?? "",
        statusCode: 202,
      });
      res.status(202).json(accepted);
    } catch (error) {
      next(error);
    }
  });

  /** The patient's view: who has asked, and who currently has access. */
  router.get("/requests", (req, res, next) => {
    try {
      const patient = requireRole(req.userId!, "patient");
      const links = repository.listCareLinksForPatient(patient.id).map((link) => ({
        id: link.id,
        status: link.status,
        reason: link.reason,
        requestedAt: link.requestedAt,
        respondedAt: link.respondedAt,
        clinician: publicUser(link.clinicianId),
      }));
      res.json({ data: links });
    } catch (error) {
      next(error);
    }
  });

  function respond(status: "approved" | "denied"): RequestHandler {
    return (req, res, next) => {
      try {
        const patient = requireRole(req.userId!, "patient");
        const link = repository.findCareLink(String(req.params.linkId));
        // Only the patient named on the link may answer it.
        if (!link || link.patientId !== patient.id) {
          res.status(404).json({ error: "Request not found" });
          return;
        }
        if (link.status !== "pending") {
          res
            .status(409)
            .json({ error: `This request was already ${link.status}.` });
          return;
        }
        repository.setCareLinkStatus(link.id, status);
        repository.recordAudit({
          userId: patient.id,
          action: `care.${status}`,
          resource: `clinician:${link.clinicianId}`,
          timestamp: new Date().toISOString(),
          ipAddress: req.ip ?? "",
          statusCode: 200,
        });
        res.json({ id: link.id, status });
      } catch (error) {
        next(error);
      }
    };
  }

  router.post("/requests/:linkId/approve", respond("approved"));
  router.post("/requests/:linkId/deny", respond("denied"));

  /** Revoking is the patient's, and only the patient's, to do. */
  router.post("/links/:linkId/revoke", (req, res, next) => {
    try {
      const patient = requireRole(req.userId!, "patient");
      const link = repository.findCareLink(String(req.params.linkId));
      if (!link || link.patientId !== patient.id) {
        res.status(404).json({ error: "Access grant not found" });
        return;
      }
      repository.setCareLinkStatus(link.id, "revoked");
      repository.recordAudit({
        userId: patient.id,
        action: "care.revoke",
        resource: `clinician:${link.clinicianId}`,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip ?? "",
        statusCode: 200,
      });
      res.json({ id: link.id, status: "revoked" });
    } catch (error) {
      next(error);
    }
  });

  /* ------------------------------- clinician ------------------------------ */

  router.get("/patients", (req, res, next) => {
    try {
      const clinician = requireRole(req.userId!, "clinician");
      const links = repository
        .listCareLinksForClinician(clinician.id)
        .filter((link) => link.status === "approved");
      res.json({
        data: links.map((link) => ({
          linkId: link.id,
          patient: publicUser(link.patientId),
          since: link.respondedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /** A clinician's own outbox, so a pending request isn't a black hole. */
  router.get("/requests/sent", (req, res, next) => {
    try {
      const clinician = requireRole(req.userId!, "clinician");
      res.json({
        data: repository.listCareLinksForClinician(clinician.id).map((link) => ({
          id: link.id,
          status: link.status,
          requestedAt: link.requestedAt,
          respondedAt: link.respondedAt,
          patient:
            link.status === "approved" ? publicUser(link.patientId) : undefined,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/patients/:patientId/plan", (req, res, next) => {
    try {
      const clinician = requireRole(req.userId!, "clinician");
      const patientId = String(req.params.patientId);
      requireApprovedLink(clinician.id, patientId);

      const documents = repository.listDocuments(patientId);
      const latest = documents.find((document) => document.plan);
      repository.recordAudit({
        userId: clinician.id,
        action: "care.read_plan",
        resource: `patient:${patientId}`,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip ?? "",
        statusCode: 200,
      });
      res.json({
        patient: publicUser(patientId),
        documentId: latest?.id,
        plan: latest?.plan ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  /* -------------------------------- alerts -------------------------------- */

  /**
   * Raised by the patient. These are records, not deliveries — nothing here
   * sends mail, and the response says exactly who can see it so the patient is
   * never left believing a doctor has been paged.
   */
  router.post("/alerts", (req, res, next) => {
    try {
      const patient = requireRole(req.userId!, "patient");
      const parsed = alertSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A symptom and an action are required." });
        return;
      }

      const alert = repository.createCareAlert({
        patientId: patient.id,
        ...parsed.data,
      });
      const recipients = repository
        .listCareLinksForPatient(patient.id)
        .filter((link) => link.status === "approved")
        .map((link) => publicUser(link.clinicianId)?.email)
        .filter((email): email is string => Boolean(email));

      repository.recordAudit({
        userId: patient.id,
        action: "care.alert",
        resource: `alert:${alert.id}`,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip ?? "",
        statusCode: 201,
      });

      res.status(201).json({
        id: alert.id,
        createdAt: alert.createdAt,
        visibleTo: recipients,
        // Said plainly rather than implied: an empty list means nobody saw it.
        delivered: false,
        message: recipients.length
          ? "Saved. The clinicians you've approved will see this in their alerts."
          : "Saved to your record. No clinician has access yet, so nobody has been notified.",
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/alerts", (req, res, next) => {
    try {
      const user = repository.findUserById(req.userId!);
      if (!user) throw new AppError(401, "Authentication required", "UNAUTHORIZED");

      const alerts =
        user.role === "clinician"
          ? repository.listAlertsForClinician(user.id).map((alert) => ({
              ...alert,
              patient: publicUser(alert.patientId),
              read: alert.readBy.includes(user.id),
            }))
          : repository.listAlertsForPatient(user.id);

      res.json({ data: alerts });
    } catch (error) {
      next(error);
    }
  });

  router.post("/alerts/:alertId/read", (req, res, next) => {
    try {
      const clinician = requireRole(req.userId!, "clinician");
      const visible = repository
        .listAlertsForClinician(clinician.id)
        .some((alert) => alert.id === req.params.alertId);
      if (!visible) {
        res.status(404).json({ error: "Alert not found" });
        return;
      }
      repository.markAlertRead(String(req.params.alertId), clinician.id);
      res.json({ id: req.params.alertId, read: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const careRouter = createCareRouter();
