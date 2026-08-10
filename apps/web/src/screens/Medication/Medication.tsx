import { useState } from "react";
import { RecoveryGate } from "../../components/RecoveryGate";
import { EmptyState } from "../../components/EmptyState";
import { Verbatim } from "../../components/Verbatim";
import type { Medication } from "../../types";

function MedicationRow({ med }: { med: Medication }) {
  const [open, setOpen] = useState(false);
  const hasDetail =
    Boolean(med.foodInstructions) ||
    Boolean(med.missedDoseInstructions) ||
    (med.sideEffects?.length ?? 0) > 0;

  return (
    <div className="med-card">
      <span className="med-mark" aria-hidden="true">
        <i className="ph-duotone ph-pill" />
      </span>

      <div className="med-main">
        <div className="med-title">
          <Verbatim as="h3">{med.name}</Verbatim>
          {/* The dose is the thing someone is scanning for, so it sits beside
              the name at full weight rather than in the grey sub-line. */}
          <Verbatim as="span" className="med-dose">
            {med.dose}
          </Verbatim>
        </div>

        <Verbatim as="p" className="gloss med-sub">
          {[med.genericName, med.frequency, med.foodInstructions]
            .filter(Boolean)
            .join(" · ")}
        </Verbatim>

        {med.purpose && <p className="med-purpose">{med.purpose}</p>}

        {/* These report a schedule rather than offering a choice. Styled as
            chips, all three read as pressable and the two that aren't part of
            the prescription looked merely unselected. The icon and the
            strike-through carry the meaning, so it isn't colour alone. */}
        <div className="slots">
          {(
            [
              ["Morning", med.morning, "ph-sun-horizon"],
              ["Afternoon", med.afternoon, "ph-sun"],
              ["Evening", med.evening, "ph-moon"],
            ] as const
          ).map(([label, on, icon]) => (
            <span key={label} className={`slot ${on ? "on" : "off"}`}>
              <i className={`ph-duotone ${icon}`} aria-hidden="true" />
              {label}
              <span className="sr-only">
                {on ? " — scheduled" : " — not scheduled"}
              </span>
            </span>
          ))}
        </div>

        {/* Only offered when there is something behind it — a "Details" button
            that opens an empty panel is worse than no button. */}
        {hasDetail && (
          <>
            <button
              className="btn-ghost med-toggle"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? "Hide details" : "Details"}
            </button>
            {open && (
              <dl className="med-detail">
                {med.foodInstructions && (
                  <>
                    <dt>Food</dt>
                    <dd>{med.foodInstructions}</dd>
                  </>
                )}
                {med.sideEffects && med.sideEffects.length > 0 && (
                  <>
                    <dt>Possible side effects</dt>
                    <dd>{med.sideEffects.join(", ")}</dd>
                  </>
                )}
                {med.missedDoseInstructions && (
                  <>
                    <dt>If you miss a dose</dt>
                    <dd>{med.missedDoseInstructions}</dd>
                  </>
                )}
              </dl>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Medication() {
  return (
    <div>
      <div className="page-head">
        <h1>Medications</h1>
        <p className="lede">
          From your own medication list — nothing here is guessed.
        </p>
      </div>
      <RecoveryGate
        emptyState={{
          icon: "ph-pill",
          title: "No medications to show",
          description:
            "Medications from your active recovery guide will appear here, including dose and timing details.",
        }}
      >
        {(data) =>
          data.medications.length === 0 ? (
            <EmptyState
              icon="ph-pill"
              title="No medications found"
              description="Your document didn't list any medications."
            />
          ) : (
            <>
              {data.medications.map((m) => (
                <MedicationRow key={m.id} med={m} />
              ))}
            </>
          )
        }
      </RecoveryGate>
    </div>
  );
}
