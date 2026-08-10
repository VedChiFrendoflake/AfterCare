import bcrypt from "bcryptjs";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { repository } from "../db/repository.js";
import { AppError, unauthorized } from "../errors.js";
import {
  verifyGoogleIdToken,
  type IdTokenVerifier,
} from "../integrations/googleIdentity.js";
import { createTokens, hashToken } from "../middleware/auth.js";

const credentials = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
  // Defaults to patient: an account only becomes a clinician by asking to be
  // one at sign-up, and the role by itself grants no access to anyone's records.
  role: z.enum(["patient", "clinician"]).default("patient"),
  displayName: z.string().max(120).optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

interface RefreshClaims {
  sub: string;
  type: "refresh";
}

async function issueSession(userId: string, email: string) {
  const tokens = createTokens(userId);
  repository.createSession(
    userId,
    await hashToken(tokens.refreshToken),
    new Date(Date.now() + tokens.refreshExpiresInSeconds * 1_000).toISOString(),
  );
  const stored = repository.findUserById(userId);
  return {
    user: {
      id: userId,
      email,
      role: stored?.role ?? "patient",
      displayName: stored?.displayName,
    },
    ...tokens,
  };
}

function verifyRefreshToken(raw: string): string {
  let claims: RefreshClaims;
  try {
    claims = jwt.verify(raw, config.JWT_REFRESH_SECRET) as RefreshClaims;
  } catch {
    throw unauthorized("Invalid or expired refresh token");
  }
  if (claims.type !== "refresh" || !claims.sub) {
    throw unauthorized("Invalid refresh token");
  }
  return claims.sub;
}

const googleSchema = z.object({ idToken: z.string().min(1).max(4096) });

export const authRouter = Router();

authRouter.post("/register", async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success)
      throw new AppError(
        400,
        "Valid email and 12+ character password required",
        "INVALID_INPUT",
      );
    if (repository.findUserByEmail(parsed.data.email)) {
      throw new AppError(
        409,
        "An account with that email already exists",
        "EMAIL_EXISTS",
      );
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = repository.createUser(
      parsed.data.email,
      passwordHash,
      "password",
      parsed.data.role,
      parsed.data.displayName,
    );
    res.status(201).json(await issueSession(user.id, user.email));
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success)
      throw new AppError(400, "Valid credentials required", "INVALID_INPUT");
    const user = repository.findUserByEmail(parsed.data.email);
    if (user && user.passwordHash === null) {
      // Tell them which door to use. "Email or password is incorrect" would be
      // technically true and completely unhelpful for a Google-created account.
      throw new AppError(
        409,
        "This account uses Google sign-in. Continue with Google instead.",
        "USE_GOOGLE_SIGN_IN",
      );
    }
    if (
      !user ||
      !user.passwordHash ||
      !(await bcrypt.compare(parsed.data.password, user.passwordHash))
    ) {
      throw new AppError(
        401,
        "Email or password is incorrect",
        "INVALID_CREDENTIALS",
      );
    }
    res.json(await issueSession(user.id, user.email));
  } catch (error) {
    next(error);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success)
      throw new AppError(400, "A refresh token is required", "INVALID_INPUT");
    const userId = verifyRefreshToken(parsed.data.refreshToken);
    const user = repository.findUserById(userId);
    const sessions = repository.listSessionsForUser(userId);
    const session = (
      await Promise.all(
        sessions.map(async (candidate) =>
          (await bcrypt.compare(
            parsed.data.refreshToken,
            candidate.refreshTokenHash,
          ))
            ? candidate
            : null,
        ),
      )
    ).find((candidate) => candidate !== null);
    if (!session || !user || session.expiresAt <= new Date().toISOString()) {
      // A present-but-unmatched session means the token was already rotated
      // or revoked (reuse). Revoke the whole session family and reject.
      repository.deleteSessionsForUser(userId);
      throw unauthorized("Session expired or revoked");
    }
    repository.deleteSession(session.id);
    res.json(await issueSession(user.id, user.email));
  } catch (error) {
    next(error);
  }
});

/**
 * Sign in (or sign up) with Google.
 *
 * One route for both: Google has already proven the person controls the
 * address, so a first-time sign-in creates the account rather than dead-ending
 * on "no account found".
 *
 * `verifyIdToken` is injected so tests can exercise the account logic without
 * reaching Google; production uses the real verifier.
 */
export function createGoogleAuthRouter(
  verifyIdToken: IdTokenVerifier = verifyGoogleIdToken,
) {
  const router = Router();
  router.post("/", async (req, res, next) => {
    try {
      const parsed = googleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "A Google ID token is required", "INVALID_INPUT");
      }

      const identity = await verifyIdToken(parsed.data.idToken);
      const existing = repository.findUserByEmail(identity.email);

      // An existing password account is kept and signed in, not duplicated:
      // Google has verified the same address, so it's the same person.
      const user =
        existing ?? repository.createUser(identity.email, null, "google");

      res
        .status(existing ? 200 : 201)
        .json(await issueSession(user.id, user.email));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

authRouter.post("/logout", async (req, res, next) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.sendStatus(204);
      return;
    }
    const claims = jwt.decode(parsed.data.refreshToken) as RefreshClaims | null;
    if (claims?.sub) {
      for (const candidate of repository.listSessionsForUser(claims.sub)) {
        if (
          await bcrypt.compare(
            parsed.data.refreshToken,
            candidate.refreshTokenHash,
          )
        ) {
          repository.deleteSession(candidate.id);
          break;
        }
      }
    }
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});
