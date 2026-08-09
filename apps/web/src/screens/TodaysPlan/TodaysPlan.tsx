import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  LEVEL_LABEL,
  LEVEL_TAG_CLASS,
  dailyMedicationPlan,
  recoveryDayNumber,
  timelineAroundDay,
  type MedicationSlot,
} from "@discharge-guide/shared-types";
import { RecoveryGate } from "../../components/RecoveryGate";
import { Verbatim } from "../../components/Verbatim";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { dosesFor, mergeTakenAt, recordDose, subscribeDoses } from "../../services/adherence";
import { latestCheckIn, subscribeCheckIns } from "../../services/checkIns";
import { SymptomCheckIn } from "./SymptomCheckIn";
import type { Medication, RecoveryData } from "../../types";

const SLOT_LABEL: Record<MedicationSlot, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

export default function TodaysPlan() {
  return (
    <div>
      <h1>Today&rsquo;s plan</h1>
      <p className="gloss measure">
        What your own discharge paperwork asks of you today. Nothing here is
        guessed &mdash; every item comes from your document.
      </p>

      <RecoveryGate
        emptyState={{
          icon: "ph-sun-horizon",
          title: "No plan for today yet",
          description:
            "Once your document is processed, today's medications and steps will appear here.",
        }}
      >
        {(data) => <PlanForToday data={data} />}
      </RecoveryGate>
    </div>
  );
}

function PlanForToday({ data }: { data: RecoveryData }) {
  // Re-render when a dose is logged so the checkboxes reflect the store.
  const [, setTick] = useState(0);
  useEffect(() => subscribeDoses(() => setTick((n) => n + 1)), []);

  const logged = dosesFor(data.documentId);
  const medications = data.medications.map((med) => ({
    ...med,
    takenAt: mergeTakenAt(med.takenAt, logged[med.id]),
  }));

  // processedAt is the day-1 anchor; older guides only carry updatedAt.
  const dayNumber = recoveryDayNumber(data.processedAt ?? data.updatedAt);
  const { scheduled, asNeeded } = dailyMedicationPlan(medications);
  const timelineToday = timelineAroundDay(data.timeline);

  const nothingToday =
    scheduled.length === 0 && asNeeded.length === 0 && timelineToday.length === 0;

  return (
    <div>
      {dayNumber !== null && (
        <p className="kicker" style={{ marginBottom: "var(--sp4)" }}>
          Day {dayNumber} of your recovery
        </p>
      )}

      {nothingToday ? (
        <EmptyState
          icon="ph-sun-horizon"
          title="Nothing scheduled for today"
          description="Your document didn't set out medications or steps for today. Your full guide is still available from the menu."
        />
      ) : (
        <>
          {scheduled.length > 0 && (
            <section className="divider-section">
              <h2>Medications due today</h2>
              {scheduled.map((entry) => (
                <DoseRow
                  key={entry.medication.id}
                  documentId={data.documentId}
                  medication={entry.medication}
                  slots={entry.slots}
                  dosesToday={entry.dosesToday}
                  complete={entry.complete}
                />
              ))}
            </section>
          )}

          {asNeeded.length > 0 && (
            <section className="divider-section">
              <h2>Only if you need it</h2>
              <p className="gloss">
                Your document didn&rsquo;t set a fixed time for these.
              </p>
              {asNeeded.map((med) => (
                <div key={med.id} className="card" style={{ marginTop: "var(--sp3)" }}>
                  <Verbatim as="h3">{med.name}</Verbatim>
                  <Verbatim as="p" className="gloss">
                    {[med.dose, med.frequency].filter(Boolean).join(" · ")}
                  </Verbatim>
                </div>
              ))}
            </section>
          )}

          {timelineToday.length > 0 && (
            <section className="divider-section">
              <h2>Steps around today</h2>
              {timelineToday.map((step) => (
                <div key={step.id} className="card" style={{ marginTop: "var(--sp3)" }}>
                  <span className="tag tag-low">{step.label}</span>
                  <h3 style={{ marginTop: 8 }}>{step.title}</h3>
                  {step.description && (
                    <p className="gloss" style={{ margin: 0 }}>
                      {step.description}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <TodaysCheckIn documentId={data.documentId} />

      <SymptomCheckIn documentId={data.documentId} warnings={data.warnings ?? []} />
    </div>
  );
}

/** Today's traffic-light status, or a prompt to record one. */
function TodaysCheckIn({ documentId }: { documentId: string }) {
  const [, setTick] = useState(0);
  useEffect(() => subscribeCheckIns(() => setTick((n) => n + 1)), []);

  const latest = latestCheckIn(documentId);
  const isToday =
    latest !== null &&
    new Date(latest.createdAt).toDateString() === new Date().toDateString();

  return (
    <section className="divider-section">
      <h2>Your check-in</h2>
      {isToday && latest ? (
        <div className="card">
          <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className={`tag ${LEVEL_TAG_CLASS[latest.overall]}`}>
              {LEVEL_LABEL[latest.overall]}
            </span>
            <Link to="/check-in" className="btn-ghost">
              Update today&rsquo;s check-in →
            </Link>
          </div>
          <p className="gloss" style={{ margin: "var(--sp3) 0 0" }}>
            Recorded at{" "}
            {new Date(latest.createdAt).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            .
          </p>
        </div>
      ) : (
        <div className="card">
          <p className="gloss" style={{ margin: 0 }}>
            You haven&rsquo;t checked in today.
          </p>
          <Link
            to="/check-in"
            className="btn btn-solid"
            style={{ marginTop: "var(--sp3)", display: "inline-block" }}
          >
            Start today&rsquo;s check-in
          </Link>
        </div>
      )}
    </section>
  );
}

function DoseRow({
  documentId,
  medication,
  slots,
  dosesToday,
  complete,
}: {
  documentId: string;
  medication: Medication;
  slots: MedicationSlot[];
  dosesToday: number;
  complete: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTake() {
    setBusy(true);
    setError(null);
    try {
      await recordDose(documentId, medication.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't record that dose."
      );
    } finally {
      setBusy(false);
    }
  }

  const checkboxId = `dose-${medication.id}`;

  return (
    <div className="card" style={{ marginTop: "var(--sp3)" }}>
      <Verbatim as="h3">{medication.name}</Verbatim>
      <Verbatim as="p" className="gloss">
        {[medication.dose, medication.frequency].filter(Boolean).join(" · ")}
      </Verbatim>
      <div className="flex" style={{ marginTop: 8, flexWrap: "wrap" }}>
        {slots.map((slot) => (
          <span key={slot} className="chip active">
            {SLOT_LABEL[slot]}
          </span>
        ))}
      </div>

      {/* Stacked rather than beside the details: at 375px a two-column row
          wraps the dose text mid-phrase and squeezes the tap target. */}
      <div
        className="row-between"
        style={{ marginTop: "var(--sp3)", flexWrap: "wrap", gap: 8 }}
      >
        <label
          htmlFor={checkboxId}
          className="flex"
          style={{ gap: 8, cursor: busy ? "wait" : "pointer", minHeight: 44 }}
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={complete}
            disabled={busy || complete}
            onChange={handleTake}
          />
          {complete ? "All doses taken" : "Mark taken"}
        </label>
        <p className="gloss" style={{ margin: 0, fontSize: 15 }}>
          {dosesToday} of {slots.length} today
        </p>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => setError(null)} />}
    </div>
  );
}
