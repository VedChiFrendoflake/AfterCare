import { useMemo, useState } from "react";
import { citationText } from "@discharge-guide/shared-types";
import { RecoveryGate } from "../../components/RecoveryGate";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ApiError, backendAsk } from "../../services/backend";
import { currentMode } from "../../services/config";
import type { FaqEntry, RecoveryData } from "../../types";

function Citation({ sourceLines }: { sourceLines?: readonly number[] }) {
  const text = citationText(sourceLines);
  if (!text) return null;
  return (
    <p className="gloss" style={{ fontStyle: "italic", fontSize: 14 }}>
      {text}
    </p>
  );
}

/** Despite the folder name (matching the original scaffold), this is a search over
 *  answers drawn from the patient's own document — not a chatbot. When the API is
 *  connected the same box asks it directly, and every answer cites the document
 *  lines it came from. */
export default function AskAI() {
  const [query, setQuery] = useState("");

  return (
    <div>
      <h1>Ask a question</h1>
      <p className="gloss measure">
        Search questions answered directly from your own paperwork. This isn't a
        chat — every answer is something your document actually says.
      </p>

      <RecoveryGate
        emptyState={{
          icon: "ph-question",
          title: "No document answers yet",
          description:
            "Questions and answers grounded in your active recovery guide will appear here when they are available.",
        }}
      >
        {(data) => <AskPanel query={query} onQueryChange={setQuery} data={data} />}
      </RecoveryGate>
    </div>
  );
}

function AskPanel({
  query,
  onQueryChange,
  data,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  data: RecoveryData;
}) {
  // Only the API can answer a new question against the source document. In
  // other modes the box stays a search over answers already extracted.
  const canAsk = currentMode() === "backend";

  return (
    <div>
      <SearchField query={query} onQueryChange={onQueryChange} canAsk={canAsk} />
      {canAsk && <AskTheDocument documentId={data.documentId} question={query} />}
      <FaqList query={query} faq={data.faq} />
    </div>
  );
}

function SearchField({
  query,
  onQueryChange,
  canAsk,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  canAsk: boolean;
}) {
  return (
    <div className="field" role="search">
      <label htmlFor="faq-search" className="sr-only">
        Search your questions
      </label>
      <input
        id="faq-search"
        type="search"
        placeholder={canAsk ? "Ask about your document…" : "Search your questions…"}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
    </div>
  );
}

function AskTheDocument({
  documentId,
  question,
}: {
  documentId: string;
  question: string;
}) {
  const [answer, setAnswer] = useState<{
    question: string;
    answer: string;
    sourceLines: number[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(
    null
  );

  const trimmed = question.trim();

  async function handleAsk() {
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await backendAsk(documentId, trimmed, () =>
        setRetrying(true)
      );
      setAnswer({
        question: trimmed,
        answer: result.answer,
        sourceLines: result.source?.sourceLines ?? [],
      });
    } catch (err) {
      setError({
        message:
          err instanceof Error ? err.message : "Couldn't answer that just now.",
        // "Try again" on a permanent failure is a trap — it invites the patient
        // to keep pressing a button that cannot work.
        retryable: err instanceof ApiError ? err.retryable : true,
      });
    } finally {
      setBusy(false);
      setRetrying(false);
    }
  }

  return (
    <div style={{ marginBottom: "var(--sp4)" }}>
      <button
        className="btn btn-solid"
        onClick={handleAsk}
        disabled={busy || trimmed.length === 0}
      >
        {busy && <span className="spinner" style={{ marginRight: 8 }} />}
        Ask my document
      </button>

      {/* 30+ seconds of silent spinner reads as a hang. Say what is happening
          instead: the assistant is busy and the app is waiting for it. */}
      {retrying && (
        <p className="gloss" role="status" style={{ marginTop: "var(--sp2)" }}>
          The assistant is busy right now — waiting a moment and trying again.
        </p>
      )}

      {error && (
        <ErrorBanner
          message={error.message}
          onRetry={error.retryable ? () => setError(null) : undefined}
        />
      )}

      {answer && (
        <div className="card" style={{ marginTop: "var(--sp3)" }}>
          <h3>{answer.question}</h3>
          <p className="gloss" style={{ marginTop: 8 }}>
            {answer.answer}
          </p>
          {answer.sourceLines.length > 0 ? (
            <Citation sourceLines={answer.sourceLines} />
          ) : (
            <p className="gloss" style={{ fontStyle: "italic", fontSize: 14 }}>
              This wasn&rsquo;t found in your document — check with your care team.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FaqList({ query, faq }: { query: string; faq: FaqEntry[] }) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return faq;
    return faq.filter(
      (f) =>
        f.question.toLowerCase().includes(q) ||
        f.answer.toLowerCase().includes(q),
    );
  }, [query, faq]);

  if (faq.length === 0) {
    return (
      <EmptyState
        icon="ph-question"
        title="No questions yet"
        description="Once your document is processed, common questions and their answers will appear here."
      />
    );
  }
  if (filtered.length === 0) {
    return <p className="gloss">No matches for &ldquo;{query}&rdquo;.</p>;
  }

  return (
    <div>
      {filtered.map((f) => (
        <div key={f.id} className="card divider-section">
          <h3>{f.question}</h3>
          <p className="gloss" style={{ marginTop: 8 }}>
            {f.answer}
          </p>
          {f.sourceLabel && (
            <p className="gloss" style={{ fontStyle: "italic", fontSize: 14 }}>
              From: {f.sourceLabel}
            </p>
          )}
          <Citation sourceLines={f.sourceLines} />
        </div>
      ))}
    </div>
  );
}
