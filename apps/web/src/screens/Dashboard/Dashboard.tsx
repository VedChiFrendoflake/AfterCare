import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { assessFollowUp } from "@discharge-guide/shared-types";
import { RecoveryGate } from "../../components/RecoveryGate";
import { Card } from "../../components/Cards/Card";
import { ConditionCard } from "../../components/ConditionCard";
import { FollowUpBadge } from "../../components/FollowUpBadge";
import { SignOutButton } from "../../components/SignOutButton";
import { Verbatim } from "../../components/Verbatim";
import { dosesFor, mergeTakenAt, subscribeDoses } from "../../services/adherence";
import { checkInsFor, subscribeCheckIns } from "../../services/checkIns";
import type { RecoveryData } from "../../types";

function FollowUpSummary({ data }: { data: RecoveryData }) {
  // Both logs live outside the guide, so re-render when either changes.
  const [, setTick] = useState(0);
  useEffect(() => subscribeDoses(() => setTick((n) => n + 1)), []);
  useEffect(() => subscribeCheckIns(() => setTick((n) => n + 1)), []);

  const logged = dosesFor(data.documentId);
  const assessment = assessFollowUp({
    medications: data.medications.map((med) => ({
      timing: med.timing,
      frequency: med.frequency,
      takenAt: mergeTakenAt(med.takenAt, logged[med.id]),
    })),
    checkIns: checkInsFor(data.documentId),
    appointments: data.appointments.map((appt) => ({ isoDate: appt.isoDate })),
    processedAt: data.processedAt ?? data.updatedAt,
  });

  return <FollowUpBadge assessment={assessment} />;
}

export default function Dashboard() {
  return (
    <div>
      <div className="page-head">
        <h1>Your recovery guide</h1>
        <p className="lede">
          A clear view of the care details found in your active document.
          Nothing here is guessed.
        </p>
      </div>

      <RecoveryGate>
        {(data) => (
          <>
            <FollowUpSummary data={data} />
            <ConditionCard glossary={data.glossary} />

            <div className="grid-cards">
              {/* Naming the medications beats reporting "3 found": the point of
                  the dashboard is recognising your own list at a glance. */}
              <Card
                title="Medications"
                icon="ph-pill"
                tone="accent"
                count={data.medications.length}
                action={
                  data.medications.length
                    ? { to: "/medications", label: "See doses and timing" }
                    : undefined
                }
              >
                {data.medications.length === 0 ? (
                  <p className="gloss">No medications were found in your document.</p>
                ) : (
                  <ul className="mini-list">
                    {data.medications.slice(0, 4).map((med) => (
                      <li key={med.id}>
                        <Verbatim as="strong">{med.name}</Verbatim>
                        <Verbatim as="span" className="gloss">
                          {[med.dose, med.frequency].filter(Boolean).join(" \u00b7 ")}
                        </Verbatim>
                      </li>
                    ))}
                    {data.medications.length > 4 && (
                      <li className="gloss">and {data.medications.length - 4} more</li>
                    )}
                  </ul>
                )}
              </Card>

              <Card
                title="Appointments"
                icon="ph-calendar-check"
                tone="accent"
                count={data.appointments.length}
                action={
                  data.appointments.length
                    ? { to: "/appointments", label: "See all visits" }
                    : undefined
                }
              >
                {data.appointments.length === 0 ? (
                  <p className="gloss">No appointments were found in your document.</p>
                ) : (
                  <ul className="mini-list">
                    {data.appointments.slice(0, 3).map((appt) => (
                      <li key={appt.id}>
                        <strong>{appt.providerName}</strong>
                        <Verbatim as="span" className="gloss">
                          {[appt.specialty, appt.date].filter(Boolean).join(" \u00b7 ")}
                        </Verbatim>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* Alert tone: on a grid where every panel looked identical, the
                  one someone might need in a hurry looked like the rest. */}
              <Card
                title="When to get help"
                icon="ph-first-aid-kit"
                tone="alert"
                count={data.redFlagSymptoms.length}
                action={{ to: "/emergency", label: "Review your warning signs" }}
              >
                {data.redFlagSymptoms.length === 0 ? (
                  <p className="gloss">
                    No warning signs were found. Follow your care team's advice about
                    when to seek help.
                  </p>
                ) : (
                  <ul className="mini-list">
                    {data.redFlagSymptoms.slice(0, 3).map((symptom, index) => (
                      <li key={index}><span>{symptom}</span></li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                title="Restrictions"
                icon="ph-shield-warning"
                count={data.restrictions.length}
              >
                {data.restrictions.length === 0 ? (
                  <p className="gloss">
                    No activity restrictions were found in your document.
                  </p>
                ) : (
                  <ul className="mini-list">
                    {data.restrictions.map((r) => (
                      <li key={r.id}><span>{r.label}</span></li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </RecoveryGate>

      {/* Outside the gate on purpose: signing out must work even when there is
          no document yet and the gate is showing its empty state. */}
      <div
        className="divider-section"
        style={{ marginTop: "var(--sp6)", paddingTop: "var(--sp4)", borderTop: "1px solid var(--color-divider)" }}
      >
        <SignOutButton />
      </div>
    </div>
  );
}
