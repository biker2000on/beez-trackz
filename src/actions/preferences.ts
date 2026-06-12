"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getPreferences() {
  await requireSession();
  const result = await db.select().from(userSettings).limit(1);
  return result[0] || null;
}

export async function updatePreferences(_prevState: unknown, formData: FormData) {
  await requireSession();
  const theme = formData.get("theme") as string;
  const defaultApiaryId = formData.get("defaultApiaryId") as string;
  const dateFormat = formData.get("dateFormat") as string;
  const weightUnit = formData.get("weightUnit") as string;

  const existing = await db.select().from(userSettings).limit(1);
  if (!existing[0]) return { error: "No settings found" };

  await db.update(userSettings).set({
    theme: theme || "system",
    defaultApiaryId: defaultApiaryId && defaultApiaryId !== "__none__" ? defaultApiaryId : null,
    dateFormat: dateFormat || "MM/DD/YYYY",
    weightUnit: weightUnit || "oz",
    updatedAt: new Date(),
  }).where(eq(userSettings.id, existing[0].id));

  revalidatePath("/settings/preferences");
  return { success: true };
}
