import { describe, it, expect, beforeAll } from "vitest";
import { createSession, verifySession } from "@/lib/session";

describe("session", () => {
  beforeAll(() => {
    // Set SESSION_SECRET for tests
    process.env.SESSION_SECRET = "test-secret-key-for-testing-purposes-only";
  });

  it("should create a valid session token", async () => {
    const token = await createSession();
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
  });

  it("should verify a valid token", async () => {
    const token = await createSession();
    const valid = await verifySession(token);
    expect(valid).toBe(true);
  });

  it("should reject an invalid token", async () => {
    const valid = await verifySession("invalid-token");
    expect(valid).toBe(false);
  });
});
