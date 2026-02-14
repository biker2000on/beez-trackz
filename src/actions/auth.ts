"use server";

import { redirect } from "next/navigation";
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
};

export async function setup(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const displayName = formData.get("displayName") as string;
  const password = formData.get("password") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!displayName || !password) {
    return { error: "Display name and password are required" };
  }

  if (password !== confirmPassword) {
    return { error: "Passwords do not match" };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters" };
  }

  // Check if user already exists
  const existing = await db.select().from(userSettings).limit(1);
  if (existing.length > 0) {
    return { error: "Setup already completed" };
  }

  const passwordHash = await hashPassword(password);
  await db.insert(userSettings).values({
    passwordHash,
    displayName,
  });

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
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { error: "Invalid password" };
  }

  const token = await createSession();
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
