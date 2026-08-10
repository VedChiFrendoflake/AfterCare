import { useState } from "react";
import { NavLink } from "react-router-dom";

/** Shared with the desktop header nav so the two can't drift apart. */
export const PRIMARY = [
  { to: "/dashboard", label: "Home", icon: "ph-rows" },
  { to: "/today", label: "Today", icon: "ph-sun-horizon" },
  { to: "/medications", label: "Meds", icon: "ph-pill" },
  { to: "/timeline", label: "Timeline", icon: "ph-clock-counter-clockwise" },
  { to: "/appointments", label: "Visits", icon: "ph-calendar-check" },
];

const MORE = [
  // `end` matters only for "/": without it a NavLink to the root path counts
  // as active on every route, so this entry would always look selected.
  { to: "/", label: "About AfterCare", icon: "ph-info", end: true },
  { to: "/check-in", label: "Daily Check-in", icon: "ph-traffic-signal" },
  { to: "/upload", label: "Documents", icon: "ph-file-text" },
  { to: "/terms", label: "Explain Terms", icon: "ph-book-open-text" },
  { to: "/ask", label: "Ask a Question", icon: "ph-question" },
  { to: "/emergency", label: "When to Get Help", icon: "ph-first-aid-kit" },
  { to: "/caregiver", label: "Caregiver Access", icon: "ph-users-three" },
  { to: "/access", label: "Who Can See My Records", icon: "ph-lock-key" },
  { to: "/accessibility", label: "Accessibility", icon: "ph-person-simple-circle" },
];

export function BottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {PRIMARY.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
          <i className={`ph-duotone ${item.icon}`} aria-hidden="true" />
          {item.label}
        </NavLink>
      ))}
      <button
        onClick={() => setMoreOpen((v) => !v)}
        aria-expanded={moreOpen}
        style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "10px 4px 8px", fontSize: 12, color: "var(--n600)" }}
      >
        <i className="ph-duotone ph-dots-three-outline" style={{ fontSize: 22 }} aria-hidden="true" />
        More
      </button>
      {moreOpen && (
        <div className="more-sheet" role="menu">
          {MORE.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMoreOpen(false)} className={({ isActive }) => (isActive ? "active" : "")}>
              <i className={`ph-duotone ${item.icon}`} aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  );
}
