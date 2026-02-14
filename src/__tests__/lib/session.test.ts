import { describe, it, expect } from "vitest";
import { createSession, verifySession } from "@/lib/session";

describe("session", () => {
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
