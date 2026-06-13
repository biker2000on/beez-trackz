"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth";
import {
  createSession,
  setSessionCookie,
  deleteSessionCookie,
} from "@/lib/session";

export type AuthFormState = {
  error?: string;
  // Non-secret field values echoed back so the form can re-seed them after
  // React resets it on a failed submit. Passwords are intentionally omitted.
  values?: { displayName?: string };
};

export async function setup(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const displayName = formData.get("displayName") as string;
  const password = formData.get("password") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!displayName || !password) {
    return { error: "Display name and password are required", values: { displayName } };
  }

  if (password !== confirmPassword) {
    return { error: "Passwords do not match", values: { displayName } };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters", values: { displayName } };
  }

  // Check if user already exists. An OIDC-bootstrapped instance has a
  // settings row without a password — let setup add one in that case.
  const existing = await db.select().from(userSettings).limit(1);
  if (existing.length > 0 && existing[0].passwordHash) {
    return { error: "Setup already completed" };
  }

  const passwordHash = await hashPassword(password);
  if (existing.length > 0) {
    await db
      .update(userSettings)
      .set({ passwordHash, displayName, updatedAt: new Date() })
      .where(eq(userSettings.id, existing[0].id));
  } else {
    await db.insert(userSettings).values({
      passwordHash,
      displayName,
    });
  }

  redirect("/login");
}

export async function login(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const password = formData.get("password") as string;

  if (!password) {
    return { error: "Password is required" };
  }

  const users = await db.select().from(userSettings).limit(1);
  if (users.length === 0) {
    redirect("/setup");
  }

  const user = users[0];
  if (!user.passwordHash) {
    return {
      error:
        "Password login is not configured for this instance. Sign in with SSO, or set a password via Setup.",
    };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { error: "Invalid password" };
  }

  const token = await createSession({
    sub: "password",
    name: user.displayName ?? undefined,
  });
  await setSessionCookie(token);
  redirect("/dashboard");
}

export async function logout() {
  await deleteSessionCookie();
  redirect("/login");
}

export async function isSetupComplete(): Promise<boolean> {
  const users = await db.select().from(userSettings).limit(1);
  return users.length > 0;
}

export async function getDisplayName(): Promise<string | null> {
  const users = await db.select().from(userSettings).limit(1);
  if (users.length === 0) return null;
  return users[0].displayName;
}
