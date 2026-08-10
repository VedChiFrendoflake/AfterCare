/**
 * Unified session handling across all three data modes.
 *
 * The important property: in local mode there is no sign-in step at all. A stable
 * anonymous identity is minted on first visit so every screen works immediately,
 * and the app is never gated behind configuration that may not exist.
 */

import { currentMode, isFirebaseConfigured, type DataMode } from "./config";
import {
  backendGoogleSignIn,
  backendLogin,
  backendRegister,
  clearSession as clearBackendSession,
  readTokens,
} from "./backend";

export interface AppUser {
  uid: string;
  email: string | null;
  isLocal: boolean;
}

const LOCAL_UID_KEY = "aftercare:localUid";

function localUser(): AppUser {
  let uid: string;
  try {
    uid = localStorage.getItem(LOCAL_UID_KEY) ?? "";
    if (!uid) {
      uid = `local-${crypto.randomUUID()}`;
      localStorage.setItem(LOCAL_UID_KEY, uid);
    }
  } catch {
    uid = "local-anonymous";
  }
  return { uid, email: null, isLocal: true };
}

/** Whether this mode requires the user to sign in before using the app. */
export function requiresSignIn(mode: DataMode): boolean {
  return mode !== "local";
}

/** Current user for a mode, or null when the mode needs a sign-in that hasn't happened. */
export async function resolveUser(mode: DataMode): Promise<AppUser | null> {
  if (mode === "local") return localUser();

  if (mode === "backend") {
    const tokens = readTokens();
    return tokens ? { uid: tokens.user.id, email: tokens.user.email, isLocal: false } : null;
  }

  // Firebase — imported lazily so the SDK never runs when it isn't configured.
  if (!isFirebaseConfigured) return localUser();
  const { auth } = await import("../firebase");
  return new Promise((resolve) => {
    const unsubscribe = auth.onAuthStateChanged((u) => {
      unsubscribe();
      resolve(u ? { uid: u.uid, email: u.email, isLocal: false } : null);
    });
  });
}

export async function signIn(email: string, password: string): Promise<AppUser> {
  const mode = currentMode();
  if (mode === "backend") {
    const user = await backendLogin(email, password);
    return { uid: user.id, email: user.email, isLocal: false };
  }
  const { signIn: firebaseSignIn } = await import("./auth");
  const u = await firebaseSignIn(email, password);
  return { uid: u.uid, email: u.email, isLocal: false };
}

export async function signUp(
  email: string,
  password: string,
  role: "patient" | "clinician" = "patient",
  displayName?: string,
): Promise<AppUser> {
  const mode = currentMode();
  if (mode === "backend") {
    const user = await backendRegister(email, password, role, displayName);
    return { uid: user.id, email: user.email, isLocal: false };
  }
  // Only the API models roles; a Firebase or local session is always a patient.
  const { signUp: firebaseSignUp } = await import("./auth");
  const u = await firebaseSignUp(email, password);
  return { uid: u.uid, email: u.email, isLocal: false };
}

/**
 * Completes a Google sign-in.
 *
 * Backend mode exchanges the ID token for an AfterCare session; Firebase mode
 * has already signed in via its popup by this point, so the user is re-read.
 */
export async function signInWithGoogle(idToken?: string): Promise<AppUser> {
  const mode = currentMode();
  if (mode === "backend") {
    if (!idToken) throw new Error("Google didn't return a sign-in token.");
    const user = await backendGoogleSignIn(idToken);
    return { uid: user.id, email: user.email, isLocal: false };
  }
  const resolved = await resolveUser(mode);
  if (!resolved) throw new Error("Google sign-in didn't complete.");
  return resolved;
}

export async function signOut(): Promise<void> {
  const mode = currentMode();
  if (mode === "backend") {
    clearBackendSession();
    return;
  }
  if (mode === "firebase") {
    const { signOutUser } = await import("./auth");
    await signOutUser();
  }
  // local mode has nothing to sign out of
}

/** Plain-language message for whatever went wrong during sign-in. */
export function friendlySessionError(err: unknown): string {
  if (err instanceof Error && err.name === "SessionExpiredError") return err.message;
  const code = (err as { code?: string })?.code;
  if (code) {
    // Firebase-style error codes
    const map: Record<string, string> = {
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/user-not-found": "We couldn't find an account with that email.",
      "auth/wrong-password": "That password doesn't match this account.",
      "auth/invalid-credential": "That email and password don't match.",
      "auth/email-already-in-use": "An account already exists with that email.",
      "auth/weak-password": "Please use a longer password.",
      "auth/too-many-requests": "Too many attempts. Please wait a few minutes.",
      "auth/network-request-failed": "We couldn't reach the server. Check your connection.",
    };
    if (map[code]) return map[code];
  }
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}
