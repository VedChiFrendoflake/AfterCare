import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { friendlySessionError, signIn, signUp } from "../services/session";
import { isGoogleSignInAvailable } from "../services/googleSignIn";
import { GoogleSignInButton } from "./GoogleSignInButton";

type Mode = "signin" | "signup";

export function AuthForm() {
  const { mode: dataMode, refresh } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"patient" | "clinician">("patient");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The API requires 12+ characters; Firebase accepts 6. Ask for whatever the
  // active backing service will actually accept.
  const minLength = dataMode === "backend" ? 12 : 6;
  const googleAvailable = isGoogleSignInAvailable();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < minLength) {
      setError(`Please use a password of at least ${minLength} characters.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === "signin") await signIn(email, password);
      else await signUp(email, password, role, displayName.trim() || undefined);
      await refresh();
    } catch (err) {
      setError(friendlySessionError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card auth-card">
      {/* Google first: it's the primary route in, and for most people it's one
          tap with nothing to remember. Email and password stay below as the
          fallback for anyone without a Google account, or when Google's script
          is blocked. */}
      {googleAvailable && (
        <>
          <GoogleSignInButton onError={setError} />
          <div className="row-between" style={{ margin: "var(--sp4) 0" }}>
            <hr className="hair" style={{ flex: 1 }} />
            <span className="gloss" style={{ fontSize: 14 }}>
              or use an email address
            </span>
            <hr className="hair" style={{ flex: 1 }} />
          </div>
        </>
      )}

      <div className="auth-toggle" role="tablist">
        <button
          role="tab"
          aria-selected={mode === "signin"}
          className={mode === "signin" ? "active" : ""}
          onClick={() => setMode("signin")}
        >
          Sign in
        </button>
        <button
          role="tab"
          aria-selected={mode === "signup"}
          className={mode === "signup" ? "active" : ""}
          onClick={() => setMode("signup")}
        >
          Create account
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={minLength}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="gloss" style={{ fontSize: 14 }}>
            At least {minLength} characters.
          </span>
        </div>

        {/* Only on sign-up, and only where the API models roles. Choosing
            "clinician" grants nothing by itself — a clinician still has to ask
            each patient, and only that patient can say yes. */}
        {mode === "signup" && dataMode === "backend" && (
          <>
            <div className="field">
              <label htmlFor="account-role">This account is for</label>
              <select
                id="account-role"
                value={role}
                onChange={(e) => setRole(e.target.value as "patient" | "clinician")}
              >
                <option value="patient">Me — I have discharge paperwork</option>
                <option value="clinician">A clinician caring for patients</option>
              </select>
            </div>
            {role === "clinician" && (
              <div className="field">
                <label htmlFor="display-name">Your name, as patients will see it</label>
                <input
                  id="display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Dr. Chen, City Cardiology"
                />
                <span className="gloss" style={{ fontSize: 14 }}>
                  Shown to a patient deciding whether to approve your request.
                </span>
              </div>
            )}
          </>
        )}

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-solid btn-block btn-lg"
          disabled={busy}
          style={{ marginTop: 8 }}
        >
          {busy && <span className="spinner" style={{ marginRight: 8 }} />}
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
