import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { AccessibilityProvider } from "./hooks/useAccessibility";
import { ReadAloudButton } from "./components/ReadAloudButton";
import { AIStatusBanner } from "./components/AIStatusBanner";
import {
  LanguageSelector,
  TranslationNotice,
} from "./components/LanguageSelector";
import { BottomNav, PRIMARY } from "./components/BottomNav/BottomNav";

import Home from "./screens/Home/Home";
import Upload from "./screens/Upload/Upload";
import Processing from "./screens/Processing/Processing";
import Dashboard from "./screens/Dashboard/Dashboard";
import TodaysPlan from "./screens/TodaysPlan/TodaysPlan";
import CheckIn from "./screens/CheckIn/CheckIn";
import Medication from "./screens/Medication/Medication";
import Appointments from "./screens/Appointments/Appointments";
import Timeline from "./screens/Timeline/Timeline";
import Emergency from "./screens/Emergency/Emergency";
import CaregiverMode from "./screens/CaregiverMode/CaregiverMode";
import AskAI from "./screens/AskAI/AskAI";
import ExplainTerms from "./screens/ExplainTerms/ExplainTerms";
import Accessibility from "./screens/Accessibility/Accessibility";

function Loading() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "var(--sp8)" }}>
      <span className="spinner" />
    </div>
  );
}

/** Only redirects when this deployment actually expects a sign-in. In local mode
 *  a user always exists, so every route is reachable immediately.
 *
 *  Carries the attempted path along. Bouncing someone to the top of a long
 *  marketing page with no explanation reads as "that button is broken" — which
 *  is exactly how tapping "Add a document" while signed out used to behave. */
function Guarded({ children }: { children: React.ReactNode }) {
  const { loading, needsSignIn } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (needsSignIn)
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function AppRoutes() {
  const { loading } = useAuth();

  return (
    <Routes>
      {/* The homepage is the front door in every state: signed out it carries
          the sign-in form, signed in it links straight through to the guide.
          It no longer bounces to /dashboard, so there is somewhere to land. */}
      <Route path="/" element={loading ? <Loading /> : <Home />} />
      <Route path="/upload" element={<Guarded><Upload /></Guarded>} />
      <Route path="/processing/:documentId" element={<Guarded><Processing /></Guarded>} />
      <Route path="/dashboard" element={<Guarded><Dashboard /></Guarded>} />
      <Route path="/today" element={<Guarded><TodaysPlan /></Guarded>} />
      <Route path="/check-in" element={<Guarded><CheckIn /></Guarded>} />
      <Route path="/medications" element={<Guarded><Medication /></Guarded>} />
      <Route path="/appointments" element={<Guarded><Appointments /></Guarded>} />
      <Route path="/timeline" element={<Guarded><Timeline /></Guarded>} />
      <Route path="/emergency" element={<Guarded><Emergency /></Guarded>} />
      <Route path="/caregiver" element={<Guarded><CaregiverMode /></Guarded>} />
      <Route path="/ask" element={<Guarded><AskAI /></Guarded>} />
      <Route path="/terms" element={<Guarded><ExplainTerms /></Guarded>} />
      <Route path="/accessibility" element={<Guarded><Accessibility /></Guarded>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const { user, needsSignIn } = useAuth();

  return (
    <AccessibilityProvider>
      <div className="app-shell">
        <a href="#main-content" className="sr-only">Skip to main content</a>
        <header className="topbar">
          {/* translate="no": the product name is a name. Left alone, Google
              rendered it "Cuidado por los convalecientes", which is both wrong
              and long enough to wrap the header onto two lines. */}
          <Link
            to="/"
            className="logo notranslate"
            translate="no"
            aria-label="AfterCare — go to the homepage"
          >
            <i className="ph-duotone ph-heartbeat" aria-hidden="true" />
            AfterCare
          </Link>
          {user && !needsSignIn && (
            <nav className="topbar-nav" aria-label="Primary">
              {PRIMARY.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => (isActive ? "active" : "")}
                >
                  <i className={`ph-duotone ${item.icon}`} aria-hidden="true" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          )}
          <span className="spacer" />
          <LanguageSelector />
          <ReadAloudButton />
        </header>

        <TranslationNotice />
        <AIStatusBanner />

        <main className="content" id="main-content">
          <AppRoutes />
        </main>

        {user && !needsSignIn && <BottomNav />}
      </div>
    </AccessibilityProvider>
  );
}
