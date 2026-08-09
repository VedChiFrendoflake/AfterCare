import { useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { AuthForm } from "../../components/AuthForm";

/**
 * The public front door.
 *
 * Everything described here is something the app actually does today — no
 * roadmap items dressed up as features, and no clinical claims. The one rule
 * the product is built on (nothing is ever invented) is stated up front rather
 * than buried, because it's the reason to trust the rest of the page.
 */

interface Feature {
  icon: string;
  title: string;
  body: string;
  to: string;
}

const FEATURES: Feature[] = [
  {
    icon: "ph-file-text",
    title: "Reads your paperwork",
    body: "Upload a discharge summary, medication list, or doctor's report — PDF or a photo. It handles several at once.",
    to: "/upload",
  },
  {
    icon: "ph-sun-horizon",
    title: "Tells you what today looks like",
    body: "Which medications are due this morning and evening, which steps belong to today, and what you've already ticked off.",
    to: "/today",
  },
  {
    icon: "ph-pill",
    title: "Lays out your medications",
    body: "Dose, timing, and purpose for each one, with the food and missed-dose instructions your document gave.",
    to: "/medications",
  },
  {
    icon: "ph-calendar-check",
    title: "Keeps your appointments together",
    body: "Every follow-up the document mentions, with the provider, place, and date in one list.",
    to: "/appointments",
  },
  {
    icon: "ph-traffic-signal",
    title: "Checks in on you daily",
    body: "Three quick questions about pain, your wound, and how you feel. Anything amber or red tells your care circle.",
    to: "/check-in",
  },
  {
    icon: "ph-first-aid-kit",
    title: "Says when to get help",
    body: "The warning signs from your own document, and exactly what each one says to do — call your provider, or call 911.",
    to: "/emergency",
  },
  {
    icon: "ph-book-open-text",
    title: "Explains the jargon",
    body: "Medical terms from your document put in plain language, each one pointing back at the line it came from.",
    to: "/terms",
  },
  {
    icon: "ph-speaker-high",
    title: "Reads itself aloud",
    body: "Every screen, out loud, at a speed you choose — plus larger text, higher contrast, and dark mode.",
    to: "/accessibility",
  },
];

export default function Home() {
  const { needsSignIn, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const signInRef = useRef<HTMLElement | null>(null);

  // Set when a guarded route bounced us here, e.g. tapping "Add a document"
  // while signed out.
  const redirectedFrom = (location.state as { from?: string } | null)?.from;

  // The sign-in form sits at the bottom of a long page, so arriving by redirect
  // otherwise looks like nothing happened.
  useEffect(() => {
    if (redirectedFrom && needsSignIn) {
      signInRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [redirectedFrom, needsSignIn]);

  // Once signed in, finish the journey the user actually started.
  useEffect(() => {
    if (redirectedFrom && !loading && !needsSignIn) {
      navigate(redirectedFrom, { replace: true });
    }
  }, [redirectedFrom, needsSignIn, loading, navigate]);

  return (
    <div>
      <section className="landing-hero">
        <p className="kicker">YOUR RECOVERY, EXPLAINED</p>
        <h1>Understand your own discharge paperwork</h1>
        <p className="gloss measure" style={{ margin: "0 auto" }}>
          You get handed six pages on the way out of hospital, on a bad day, and
          somewhere in there is which pill to stop, when to come back, and which
          symptom means go to the emergency room now. AfterCare turns that into a
          plan you can actually follow.
        </p>

        {!loading && !needsSignIn && (
          <div
            className="flex"
            style={{ justifyContent: "center", flexWrap: "wrap", marginTop: "var(--sp6)" }}
          >
            <Link to="/dashboard" className="btn btn-solid btn-lg">
              Open my guide
            </Link>
            <Link to="/upload" className="btn btn-outline btn-lg">
              Add a document
            </Link>
          </div>
        )}
      </section>

      <div className="safety-banner measure" style={{ margin: "0 auto var(--sp6)" }}>
        <strong>AfterCare never invents clinical information.</strong> Not a dose,
        not a date, not a warning sign. Everything it shows is traced back to a
        line of the document you uploaded, and when it isn&rsquo;t confident it
        says so and points you at the original. It explains your paperwork &mdash;
        it never replaces your care team.
      </div>

      <section className="divider-section">
        <h2>What it does</h2>
        <div className="home-grid">
          {FEATURES.map((feature) => (
            <Link key={feature.to} to={feature.to} className="card home-feature">
              <i
                className={`ph-duotone ${feature.icon}`}
                aria-hidden="true"
                style={{ fontSize: 30, color: "var(--color-accent)" }}
              />
              <h3 style={{ margin: "8px 0 4px" }}>{feature.title}</h3>
              <p className="gloss" style={{ margin: 0, fontSize: 16 }}>
                {feature.body}
              </p>
            </Link>
          ))}
        </div>
      </section>

      <section className="divider-section">
        <h2>How it works</h2>
        <ol className="measure gloss" style={{ paddingLeft: 20 }}>
          <li>Add your discharge summary — a PDF, or a photo of the pages.</li>
          <li>
            It reads the text, then pulls out medications, appointments, warning
            signs, and a timeline, citing the line each one came from.
          </li>
          <li>
            A separate verification step re-reads the document and drops anything
            it can&rsquo;t find support for.
          </li>
          <li>You get a guide you can read, hear, and check in against daily.</li>
        </ol>
      </section>

      {needsSignIn && (
        <section
          className="divider-section"
          ref={signInRef as React.RefObject<HTMLElement>}
        >
          <h2 style={{ textAlign: "center" }}>
            {redirectedFrom ? "Sign in to continue" : "Get started"}
          </h2>
          {redirectedFrom && (
            <p className="gloss measure" style={{ margin: "0 auto var(--sp4)" }}>
              {redirectedFrom === "/upload"
                ? "Your paperwork is stored against your account, so we need you signed in before you add it. You'll come straight back here after."
                : "You'll be taken straight back once you're signed in."}
            </p>
          )}
          <AuthForm />
        </section>
      )}
    </div>
  );
}
