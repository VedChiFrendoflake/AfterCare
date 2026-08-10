import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Verbatim } from "../../components/Verbatim";
import {
  listAlerts,
  listPatients,
  listSentRequests,
  markAlertRead,
  requestAccess,
  type CareAlert,
  type CareRequest,
  type LinkedPatient,
} from "../../services/care";

/**
 * The clinician's view: ask for access, see who granted it, read their alerts.
 *
 * There is no patient search. A clinician can only reach someone whose address
 * they already have and who has since approved them, which is the same boundary
 * the API enforces — the UI just doesn't pretend otherwise.
 */
export default function Clinician() {
  const [patients, setPatients] = useState<LinkedPatient[]>([]);
  const [sent, setSent] = useState<CareRequest[]>([]);
  const [alerts, setAlerts] = useState<CareAlert[]>([]);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, s, a] = await Promise.all([
        listPatients(),
        listSentRequests(),
        listAlerts(),
      ]);
      setPatients(p);
      setSent(s);
      setAlerts(a);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your patients.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    try {
      const result = await requestAccess(email.trim(), reason.trim() || undefined);
      setNotice(result.message);
      setEmail("");
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that request.");
    }
  }

  const pendingSent = sent.filter((r) => r.status === "pending");
  const unread = alerts.filter((a) => !a.read);

  return (
    <div>
      <div className="page-head">
        <h1>Your patients</h1>
        <p className="lede">
          Patients you're caring for, and the alerts they've raised. You only see
          someone here once they've approved your request.
        </p>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      <section className="divider-section">
        <h2>
          Alerts{unread.length > 0 ? ` (${unread.length} unread)` : ""}
        </h2>
        {loading ? (
          <div className="card" style={{ textAlign: "center" }}>
            <span className="spinner" />
          </div>
        ) : alerts.length === 0 ? (
          <EmptyState
            icon="ph-bell"
            title="No alerts"
            description="When a patient who has approved you reports a warning sign, it appears here."
          />
        ) : (
          alerts.map((alert) => (
            <div
              key={alert.id}
              className={`card card-panel ${
                alert.severity === "emergency" ? "tone-alert" : "tone-accent"
              }`}
            >
              <div className="card-head">
                <span
                  className={`card-icon ${
                    alert.severity === "emergency" ? "tone-alert" : "tone-accent"
                  }`}
                  aria-hidden="true"
                >
                  <i className="ph-duotone ph-first-aid-kit" />
                </span>
                <h3>{alert.patient?.email ?? "Patient"}</h3>
                {!alert.read && <span className="card-count">new</span>}
              </div>
              <ul className="mini-list">
                {alert.symptoms.map((symptom, index) => (
                  <li key={index}>
                    {/* Reported verbatim — this is what the patient saw. */}
                    <Verbatim as="span">{symptom}</Verbatim>
                  </li>
                ))}
              </ul>
              <p className="gloss" style={{ marginTop: "var(--sp2)" }}>
                {alert.action} · {new Date(alert.createdAt).toLocaleString()}
              </p>
              {alert.note && <p>“{alert.note}”</p>}
              {!alert.read && (
                <button
                  className="btn btn-outline"
                  style={{ marginTop: "var(--sp2)" }}
                  onClick={async () => {
                    await markAlertRead(alert.id);
                    await load();
                  }}
                >
                  Mark as seen
                </button>
              )}
            </div>
          ))
        )}
      </section>

      <section className="divider-section">
        <h2>Patients</h2>
        {patients.length === 0 ? (
          <EmptyState
            icon="ph-users-three"
            title="No patients yet"
            description="Request access below. The patient decides whether to approve it."
          />
        ) : (
          patients.map((entry) => (
            <div key={entry.linkId} className="card">
              <h3>{entry.patient?.displayName ?? entry.patient?.email}</h3>
              <p className="gloss">
                {entry.patient?.displayName ? `${entry.patient.email} · ` : ""}
                approved{" "}
                {entry.since ? new Date(entry.since).toLocaleDateString() : "recently"}
              </p>
            </div>
          ))
        )}
      </section>

      <section className="divider-section">
        <h2>Request access</h2>
        {notice && <div className="banner info">{notice}</div>}
        <form onSubmit={submit} className="card">
          <div className="field">
            <label htmlFor="patient-email">Patient's email</label>
            <input
              id="patient-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="patient@example.com"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="reason">Why you're asking (optional)</label>
            <input
              id="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Post-op follow-up at City Cardiology"
            />
          </div>
          <p className="gloss">
            They'll see this next time they sign in and can approve or decline.
            You won't be told whether the address belongs to an account.
          </p>
          <button className="btn btn-solid" type="submit">
            Send request
          </button>
        </form>

        {pendingSent.length > 0 && (
          <>
            <h3 style={{ marginTop: "var(--sp4)" }}>Waiting on a reply</h3>
            <ul className="mini-list">
              {pendingSent.map((req) => (
                <li key={req.id}>
                  <span className="gloss">
                    Sent {new Date(req.requestedAt).toLocaleDateString()} — no answer yet
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
