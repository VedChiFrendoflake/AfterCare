import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  approveRequest,
  denyRequest,
  listCareRequests,
  revokeAccess,
  type CareRequest,
} from "../../services/care";

/**
 * The patient's control over who can read their records.
 *
 * Deliberately blunt about what approving means. Someone deciding whether to
 * let a clinician see their discharge paperwork should not have to infer the
 * consequences from the word "approve", and revoking is offered in the same
 * place rather than buried in settings.
 */
export default function CareAccess() {
  const [requests, setRequests] = useState<CareRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequests(await listCareRequests());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your access list.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: () => Promise<void>) {
    setBusy(id);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  }

  const pending = requests?.filter((r) => r.status === "pending") ?? [];
  const approved = requests?.filter((r) => r.status === "approved") ?? [];
  const closed =
    requests?.filter((r) => r.status === "denied" || r.status === "revoked") ?? [];

  return (
    <div>
      <div className="page-head">
        <h1>Who can see your records</h1>
        <p className="lede">
          Clinicians can ask to see your recovery guide. Nobody sees anything
          until you say yes, and you can take access away at any time.
        </p>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      {requests === null && !error && (
        <div className="card" style={{ textAlign: "center" }}>
          <span className="spinner" />
        </div>
      )}

      {requests !== null && (
        <>
          <section className="divider-section">
            <h2>Waiting for your answer</h2>
            {pending.length === 0 ? (
              <p className="gloss">No one is waiting on a decision.</p>
            ) : (
              pending.map((req) => (
                <div key={req.id} className="card card-panel tone-accent">
                  <div className="card-head">
                    <span className="card-icon tone-accent" aria-hidden="true">
                      <i className="ph-duotone ph-user-circle" />
                    </span>
                    <h3>{req.clinician?.displayName ?? req.clinician?.email}</h3>
                  </div>
                  {req.clinician?.displayName && (
                    <p className="gloss">{req.clinician.email}</p>
                  )}
                  {req.reason && <p>“{req.reason}”</p>}
                  <p className="gloss">
                    Approving lets them read your medications, appointments,
                    warning signs, and any alerts you raise. It does not let
                    them change anything.
                  </p>
                  <div className="flex" style={{ flexWrap: "wrap", marginTop: "var(--sp3)" }}>
                    <button
                      className="btn btn-solid"
                      disabled={busy === req.id}
                      onClick={() => void act(req.id, () => approveRequest(req.id))}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn-outline"
                      disabled={busy === req.id}
                      onClick={() => void act(req.id, () => denyRequest(req.id))}
                    >
                      Not now
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="divider-section">
            <h2>Has access now</h2>
            {approved.length === 0 ? (
              <EmptyState
                icon="ph-users-three"
                title="Nobody has access"
                description="When you approve a clinician, they'll be listed here and you can remove them whenever you want."
              />
            ) : (
              approved.map((req) => (
                <div key={req.id} className="card">
                  <div className="row-between">
                    <div>
                      <h3>{req.clinician?.displayName ?? req.clinician?.email}</h3>
                      <p className="gloss">
                        {req.clinician?.displayName ? `${req.clinician.email} · ` : ""}
                        since{" "}
                        {req.respondedAt
                          ? new Date(req.respondedAt).toLocaleDateString()
                          : "recently"}
                      </p>
                    </div>
                    <button
                      className="btn btn-outline"
                      disabled={busy === req.id}
                      onClick={() => void act(req.id, () => revokeAccess(req.id))}
                    >
                      Remove access
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          {closed.length > 0 && (
            <section className="divider-section">
              <h2>Past requests</h2>
              <ul className="mini-list">
                {closed.map((req) => (
                  <li key={req.id}>
                    <strong>{req.clinician?.displayName ?? req.clinician?.email}</strong>
                    <span className="gloss">
                      {req.status === "denied" ? "Declined" : "Access removed"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
