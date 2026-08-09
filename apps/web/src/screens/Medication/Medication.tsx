import { useState } from "react";
import { RecoveryGate } from "../../components/RecoveryGate";
import { EmptyState } from "../../components/EmptyState";
import { Verbatim } from "../../components/Verbatim";
import type { Medication } from "../../types";

function MedicationRow({ med }: { med: Medication }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card divider-section">
      <div className="row-between">
        <div>
          <Verbatim as="h3">{med.name}</Verbatim>
          <Verbatim as="p" className="gloss">
            {med.genericName ? `${med.genericName} · ` : ""}
            {med.dose} · {med.frequency}
          </Verbatim>
        </div>
        <button
          className="btn-ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      <p className="gloss" style={{ marginTop: 8 }}>
        {med.purpose}
      </p>
      <div className="flex" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <span className={`chip ${med.morning ? "active" : ""}`}>Morning</span>
        <span className={`chip ${med.afternoon ? "active" : ""}`}>
          Afternoon
        </span>
        <span className={`chip ${med.evening ? "active" : ""}`}>Evening</span>
      </div>
      {open && (
        <div
          style={{
            marginTop: 12,
            borderTop: "1px solid var(--color-divider)",
            paddingTop: 12,
          }}
        >
          {med.foodInstructions && (
            <p className="gloss">Food: {med.foodInstructions}</p>
          )}
          {med.sideEffects && med.sideEffects.length > 0 && (
            <p className="gloss">
              Possible side effects: {med.sideEffects.join(", ")}
            </p>
          )}
          {med.missedDoseInstructions && (
            <p className="gloss">
              If you miss a dose: {med.missedDoseInstructions}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Medication() {
  return (
    <div>
      <h1>Medications</h1>
      <p className="gloss measure">
        From your own medication list — nothing here is guessed.
      </p>
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
