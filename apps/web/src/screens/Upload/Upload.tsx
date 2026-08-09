import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { useDocuments } from "../../hooks/useDocuments";
import { uploadDocument } from "../../services/documents";
import { fetchDriveFileBlob, isGoogleDriveConfigured, pickFileFromGoogleDrive } from "../../services/googleDrive";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { DocumentStatus } from "../../types";

interface FailedUpload {
  name: string;
  message: string;
}

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "Saved",
  processing: "Processing",
  ready: "Ready",
  error: "Couldn't be processed",
};

export default function Upload() {
  const { user } = useAuth();
  const { documents } = useDocuments(user);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<FailedUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);

  if (!user) return null;

  /**
   * Uploads a batch one file at a time.
   *
   * Sequential, not parallel: each upload reports its own progress, and the
   * pipeline queue on the API is the real bottleneck anyway. A file that fails
   * is recorded and the rest still go — losing four good uploads because the
   * third was a corrupt scan would be the wrong trade.
   */
  async function handleFiles(selected: File[]) {
    const files = selected.filter(Boolean);
    if (files.length === 0) return;

    setError(null);
    setFailures([]);
    setBatch({ done: 0, total: files.length });
    setProgress(0);

    const failed: FailedUpload[] = [];
    const succeeded: string[] = [];

    for (const [index, file] of files.entries()) {
      setBatch({ done: index, total: files.length });
      setProgress(0);
      try {
        const { documentId } = await uploadDocument(user!, file, setProgress);
        succeeded.push(documentId);
      } catch (err) {
        failed.push({
          name: file.name,
          message:
            err instanceof Error ? err.message : "Something went wrong adding that file.",
        });
      }
    }

    setBatch(null);
    setProgress(null);

    if (succeeded.length === 0) {
      // Nothing landed: the banner says it once. Listing the same failures
      // again under "the rest were added" would be both duplicated and untrue.
      setFailures([]);
      setError(
        files.length === 1
          ? (failed[0]?.message ?? "Something went wrong adding that file.")
          : "None of those files could be added.",
      );
      return;
    }

    // A partial batch is the only case worth itemising: some files are
    // processing, and the user needs to know which ones aren't.
    setFailures(failed);

    // One file behaves exactly as before. For a batch, staying here shows the
    // whole list processing at once, which a redirect to a single document
    // would hide.
    if (files.length === 1) navigate(`/processing/${succeeded[0]}`);
  }

  const handleFile = (file: File) => handleFiles([file]);

  async function handleGoogleDrive() {
    setError(null);
    setDriveBusy(true);
    try {
      const picked = await pickFileFromGoogleDrive();
      if (!picked) return; // cancelled
      const blob = await fetchDriveFileBlob(picked);
      await handleFile(new File([blob], picked.name, { type: picked.mimeType }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect to Google Drive.");
    } finally {
      setDriveBusy(false);
    }
  }

  return (
    <div>
      <h1>Add your paperwork</h1>
      <p className="gloss measure">
        Upload a PDF, take or upload a photo of your report, or connect it straight from Google Drive.
      </p>

      {error && <ErrorBanner message={error} onRetry={() => setError(null)} />}

      {failures.length > 0 && (
        <div className="banner warn" role="status">
          <strong>
            {failures.length} file{failures.length === 1 ? "" : "s"} couldn&rsquo;t be
            added.
          </strong>{" "}
          The rest were added and are processing.
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {failures.map((failure) => (
              <li key={failure.name}>
                {failure.name} &mdash; {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {documents.length > 0 && (
        <div className="card" style={{ marginBottom: "var(--sp4)" }}>
          <h2>Your documents</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {documents.map((d) => (
              <li key={d.id} className="list-row">
                <i className="ph-duotone ph-file-text" aria-hidden="true" />
                <div style={{ flex: 1 }}>
                  <Link to={`/processing/${d.id}`}>{d.fileName}</Link>
                  <p className="gloss" style={{ margin: 0 }}>
                    {STATUS_LABEL[d.status]}
                    {d.status === "error" && d.errorMessage ? ` — ${d.errorMessage}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className={`upload-dropzone ${dragging ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(Array.from(e.dataTransfer.files ?? []));
        }}
      >
        {progress !== null ? (
          <>
            <span className="spinner" />
            <p style={{ marginTop: 12 }}>
              {batch && batch.total > 1
                ? `Adding file ${batch.done + 1} of ${batch.total}… ${progress}%`
                : `Adding your document… ${progress}%`}
            </p>
            <div className="progress-bar" style={{ maxWidth: 260, margin: "12px auto" }}>
              <span style={{ width: `${progress}%` }} />
            </div>
          </>
        ) : (
          <>
            <i
              className="ph-duotone ph-upload-simple"
              style={{ fontSize: 40, color: "var(--color-accent)" }}
              aria-hidden="true"
            />
            <p style={{ margin: "12px 0" }}>
              Drag your files here, or &mdash; add as many as you like
            </p>
            <div className="flex" style={{ justifyContent: "center", flexWrap: "wrap" }}>
              <button className="btn btn-solid" onClick={() => fileInputRef.current?.click()}>
                Choose PDF files
              </button>
              <button className="btn btn-outline" onClick={() => photoInputRef.current?.click()}>
                <i className="ph-duotone ph-camera" aria-hidden="true" /> Take or upload photos
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              multiple
              hidden
              onChange={(e) => {
                handleFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {/* No `capture` attribute: on iOS it forces the camera and removes
                "Photo Library" from the sheet, so a patient photographing a
                document earlier in the day couldn't pick it. It also silently
                disables multi-select. */}
            <input
              ref={photoInputRef}
              type="file"
              /* Not `image/*`: that offered HEIC, GIF and TIFF, which the API
                 rejects on upload. Naming the formats also gets iOS to hand
                 over a JPEG rather than the HEIC it stores natively. */
              accept="image/jpeg,image/png,image/webp"
              multiple
              hidden
              onChange={(e) => {
                handleFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>

      {isGoogleDriveConfigured && (
        <>
          <div className="row-between" style={{ margin: "var(--sp4) 0" }}>
            <hr className="hair" style={{ flex: 1 }} />
            <span className="gloss">or</span>
            <hr className="hair" style={{ flex: 1 }} />
          </div>
          <button className="btn btn-outline btn-block btn-lg" onClick={handleGoogleDrive} disabled={driveBusy}>
            {driveBusy && <span className="spinner" style={{ marginRight: 8 }} />}
            <i className="ph-duotone ph-cloud-arrow-down" aria-hidden="true" /> Connect from Google Drive
          </button>
        </>
      )}
    </div>
  );
}
