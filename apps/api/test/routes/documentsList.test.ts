import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { repository } from "../../src/db/repository.js";
import { resetStorage } from "../../src/integrations/storage.js";

const app = createApp();

afterEach(() => {
  repository.reset();
  resetStorage();
});

async function registerAs(email: string) {
  const response = await request(app)
    .post("/auth/register")
    .send({ email, password: "a-safe-password-123" })
    .expect(201);
  return {
    token: response.body.accessToken as string,
    userId: repository.findUserByEmail(email)!.id,
  };
}

function addDocument(userId: string, id: string, uploadedAt: string) {
  repository.createDocument({
    id,
    userId,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    fileHash: `hash-${id}`,
    storageKey: `key-${id}`,
    uploadedAt,
    status: "ready",
  });
}

describe("GET /documents", () => {
  it("lists the caller's documents, newest first", async () => {
    const { token, userId } = await registerAs("patient@example.com");
    addDocument(userId, "older", "2026-08-01T10:00:00.000Z");
    addDocument(userId, "newer", "2026-08-05T10:00:00.000Z");

    const response = await request(app)
      .get("/documents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.data.map((d: { id: string }) => d.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("never returns another user's documents", async () => {
    const owner = await registerAs("owner@example.com");
    const other = await registerAs("other@example.com");
    addDocument(owner.userId, "owned", "2026-08-01T10:00:00.000Z");

    const response = await request(app)
      .get("/documents")
      .set("Authorization", `Bearer ${other.token}`)
      .expect(200);

    expect(response.body.data).toEqual([]);
  });

  it("returns metadata only — never the stored bytes or the plan", async () => {
    const { token, userId } = await registerAs("patient@example.com");
    addDocument(userId, "doc", "2026-08-01T10:00:00.000Z");

    const response = await request(app)
      .get("/documents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const [document] = response.body.data;
    expect(document).not.toHaveProperty("plan");
    expect(document).not.toHaveProperty("storageKey");
    expect(document).not.toHaveProperty("fileHash");
    expect(document).toMatchObject({ id: "doc", status: "ready" });
  });

  it("requires authentication", async () => {
    await request(app).get("/documents").expect(401);
  });
});
