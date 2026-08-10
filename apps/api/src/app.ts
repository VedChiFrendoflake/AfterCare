import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { cacheStatus, pingCache } from "./cache/index.js";
import { config } from "./config.js";
import { corsOriginDelegate } from "./cors.js";
import { databaseHealth } from "./db/client.js";
import {
  configuredProviders,
  providerCooldownStatus,
} from "./integrations/aiProviderWaterfall.js";
import { AiApiError, AppError } from "./errors.js";
import { googleDriveStatus } from "./integrations/googleDrive.js";
import type { IdTokenVerifier } from "./integrations/googleIdentity.js";
import { storageStatus } from "./integrations/storage.js";
import { authenticate } from "./middleware/auth.js";
import { hipaaAuditLog } from "./middleware/hipaaLogging.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { apiRateLimit, createAskRateLimit } from "./middleware/rateLimits.js";
import { pipelineQueue, type PipelineQueue } from "./queue/pipelineQueue.js";
import { accessibilityRouter } from "./routes/accessibility.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { createAskRouter, type AskGroundedFunction } from "./routes/ask.js";
import { authRouter, createGoogleAuthRouter } from "./routes/auth.js";
import { documentsRouter } from "./routes/documents.js";
import { driveCallbackRouter, driveRouter } from "./routes/drive.js";
import { medicationsRouter } from "./routes/medications.js";
import { createProcessRouter } from "./routes/process.js";
import { createUploadRouter } from "./routes/upload.js";
import { careRouter } from "./routes/care.js";

interface CreateAppOptions {
  queue?: PipelineQueue;
  askGrounded?: AskGroundedFunction;
  heartbeatMs?: number;
  /** Per-user hourly budget for /ask; overrides ASK_RATE_LIMIT. */
  askRateLimit?: number;
  /** Test seam for POST /auth/google, so tests never reach Google. */
  verifyGoogleIdToken?: IdTokenVerifier;
}

export function createApp(options: CreateAppOptions = {}) {
  const queue = options.queue ?? pipelineQueue;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin: corsOriginDelegate(config.WEB_ORIGIN),
      credentials: true,
      // DELETE is here because DELETE /documents/:id exists; omitting it meant
      // the browser's preflight refused the only route that removes a patient's
      // uploaded document.
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(securityHeaders);
  app.use(hipaaAuditLog);

  app.get("/health", async (_req, res) => {
    // /health is Render's healthCheckPath: it must fail loudly (503) when a
    // configured dependency is down so a degraded instance gets restarted
    // instead of serving "ok" from a broken backend. Unconfigured pieces
    // (memory DB, no Redis) are healthy by definition.
    const database = await databaseHealth();
    const cache = cacheStatus();
    const databaseOk = database.ok;
    const cacheOk = !cache.configured || (await pingCache());
    const ok = databaseOk && cacheOk;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "degraded",
      service: "discharge-guide-api",
      // Which build is actually serving. Without this, "is my fix deployed?"
      // can only be answered by inferring from behaviour, and a wrong guess
      // there sends you debugging code that isn't running. Render sets
      // RENDER_GIT_COMMIT; short sha only, and it is not a secret.
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "unknown",
      database,
      storage: storageStatus(),
      cache,
      queue: queue.getStats(),
      integrations: [googleDriveStatus()],
      // Ops visibility into the free-tier AI waterfall: which providers are
      // configured (never their keys) and the per-provider request timeout.
      ai: {
        timeoutMs: config.AI_TIMEOUT_MS,
        // Reports what the waterfall will actually attempt, not merely which
        // env vars are present: a key set to an empty or whitespace value is
        // skipped at request time, and saying "configured" here made that
        // impossible to spot from outside.
        waterfall: configuredProviders(),
        // Circuit-breaker state: ms remaining per provider on cooldown.
        cooldowns: providerCooldownStatus(),
      },
    });
  });
  app.use("/auth/google", apiRateLimit, createGoogleAuthRouter(options.verifyGoogleIdToken));
  app.use("/auth", apiRateLimit, authRouter);
  app.use("/drive", driveCallbackRouter);

  app.use(authenticate);
  app.use(apiRateLimit);
  app.use("/upload", createUploadRouter(queue));
  app.use(
    "/process",
    createProcessRouter(queue, options.heartbeatMs ?? 15_000),
  );
  app.use("/medications", medicationsRouter);
  app.use("/appointments", appointmentsRouter);
  app.use(
    "/ask",
    createAskRateLimit(options.askRateLimit),
    createAskRouter(options.askGrounded),
  );
  app.use("/drive", driveRouter);
  app.use("/accessibility", accessibilityRouter);
  app.use("/documents", documentsRouter);
  app.use("/care", careRouter);

  app.use((_req, res) =>
    res.status(404).json({ error: "Route not found", code: "NOT_FOUND" }),
  );

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof AiApiError) {
        res.status(error.statusCode).json(error.publicError);
        return;
      }
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
        return;
      }
      if (error instanceof ZodError) {
        res.status(400).json({
          error: "Invalid request",
          code: "INVALID_INPUT",
          details: error.issues,
        });
        return;
      }
      if (error instanceof Error && error.message === "Unsupported file type") {
        res
          .status(415)
          .json({ error: error.message, code: "UNSUPPORTED_MEDIA_TYPE" });
        return;
      }
      res
        .status(500)
        .json({ error: "Unexpected server error", code: "INTERNAL_ERROR" });
    },
  );
  return app;
}
