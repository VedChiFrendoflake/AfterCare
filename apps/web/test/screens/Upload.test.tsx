import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const { uploadDocumentMock, navigateMock } = vi.hoisted(() => ({
  uploadDocumentMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("../../src/services/documents", () => ({
  uploadDocument: uploadDocumentMock,
  validateFile: vi.fn(),
}));

vi.mock("../../src/services/googleDrive", () => ({
  isGoogleDriveConfigured: false,
  pickFileFromGoogleDrive: vi.fn(),
  fetchDriveFileBlob: vi.fn(),
}));

vi.mock("../../src/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1", isLocal: true } }),
}));

vi.mock("../../src/hooks/useDocuments", () => ({
  useDocuments: () => ({ documents: [], loading: false }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateMock,
}));

import Upload from "../../src/screens/Upload/Upload";

const pdf = (name: string) =>
  new File([`%PDF-1.4 ${name}`], name, { type: "application/pdf" });

function renderScreen() {
  return render(
    <MemoryRouter>
      <Upload />
    </MemoryRouter>,
  );
}

/** The hidden PDF input behind "Choose PDF files". */
function pdfInput(): HTMLInputElement {
  const input = document
    .querySelector('input[accept="application/pdf"]');
  if (!input) throw new Error("pdf input not found");
  return input as HTMLInputElement;
}

beforeEach(() => {
  let n = 0;
  uploadDocumentMock.mockImplementation(async (_user, _file, onProgress) => {
    onProgress?.(100);
    return { documentId: `doc-${++n}`, processing: false };
  });
});

/** The hidden photo input, found by kind rather than by an exact accept string. */
function photoInput(): HTMLInputElement {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  ];
  const photo = inputs.find((input) => input.accept.includes("image/"));
  if (!photo) throw new Error("photo input not found");
  return photo;
}

describe("Upload screen", () => {
  it("accepts multiple files on both inputs", () => {
    renderScreen();
    expect(pdfInput()).toHaveAttribute("multiple");
    expect(photoInput()).toHaveAttribute("multiple");
  });

  it("does not force the camera on the photo input", () => {
    // `capture` would remove "Photo Library" from the iOS sheet and disable
    // multi-select entirely.
    renderScreen();
    expect(photoInput()).not.toHaveAttribute("capture");
  });

  it("only offers image formats the API will accept", () => {
    // `image/*` let HEIC and TIFF through the picker, and the upload then
    // failed server-side — far from the cause, and looking like a broken app.
    renderScreen();
    const { accept } = photoInput();
    expect(accept).toContain("image/jpeg");
    expect(accept).toContain("image/png");
    expect(accept).not.toContain("image/*");
    expect(accept).not.toContain("heic");
  });

  it("uploads every selected file", async () => {
    renderScreen();
    await userEvent.upload(pdfInput(), [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]);

    await waitFor(() => expect(uploadDocumentMock).toHaveBeenCalledTimes(3));
    expect(
      uploadDocumentMock.mock.calls.map((call) => (call[1] as File).name),
    ).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  });

  it("navigates to processing for a single file, as before", async () => {
    renderScreen();
    await userEvent.upload(pdfInput(), pdf("only.pdf"));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/processing/doc-1"));
  });

  it("stays on the upload screen for a batch", async () => {
    renderScreen();
    await userEvent.upload(pdfInput(), [pdf("a.pdf"), pdf("b.pdf")]);

    await waitFor(() => expect(uploadDocumentMock).toHaveBeenCalledTimes(2));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("keeps going when one file in a batch fails", async () => {
    uploadDocumentMock
      .mockResolvedValueOnce({ documentId: "doc-1", processing: false })
      .mockRejectedValueOnce(new Error("That file is over 20MB."))
      .mockResolvedValueOnce({ documentId: "doc-3", processing: false });

    renderScreen();
    await userEvent.upload(pdfInput(), [pdf("a.pdf"), pdf("big.pdf"), pdf("c.pdf")]);

    // The third upload must still have been attempted.
    await waitFor(() => expect(uploadDocumentMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/big\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/over 20MB/)).toBeInTheDocument();
  });

  it("reports a whole-batch failure once, without the partial-success list", async () => {
    uploadDocumentMock.mockRejectedValue(new Error("Unsupported file"));

    renderScreen();
    await userEvent.upload(pdfInput(), [pdf("one.pdf"), pdf("two.pdf")]);

    expect(
      await screen.findByText(/None of those files could be added/),
    ).toBeInTheDocument();
    // "The rest were added and are processing" would be false here.
    expect(screen.queryByText(/are processing/)).not.toBeInTheDocument();
  });

  it("reports the single-file error message directly", async () => {
    uploadDocumentMock.mockRejectedValue(
      new Error("Please choose a PDF or a photo."),
    );

    renderScreen();
    await userEvent.upload(pdfInput(), pdf("bad.txt"));

    expect(
      await screen.findByText(/Please choose a PDF or a photo/),
    ).toBeInTheDocument();
  });

  it("shows batch progress while uploading", async () => {
    let release: (() => void) | undefined;
    uploadDocumentMock.mockImplementation(async (_u, _f, onProgress) => {
      onProgress?.(50);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { documentId: "doc-x", processing: false };
    });

    renderScreen();
    const upload = userEvent.upload(pdfInput(), [pdf("a.pdf"), pdf("b.pdf")]);

    expect(await screen.findByText(/Adding file 1 of 2/)).toBeInTheDocument();
    release?.();
    await upload;
  });
});
