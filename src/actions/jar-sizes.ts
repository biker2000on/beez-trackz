"use server";

import { db } from "@/db";
import { userSettings } from "@/db/schema/settings";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export interface JarSize {
  label: string;
  honeyOz: number;
}

const DEFAULT_JAR_SIZES: JarSize[] = [
  { label: "Half Pint", honeyOz: 12 },
  { label: "Pint", honeyOz: 22 },
  { label: "Quart", honeyOz: 44 },
  { label: "Half Gallon", honeyOz: 88 },
  { label: "Gallon", honeyOz: 176 },
];

export async function getJarSizes(): Promise<JarSize[]> {
  const users = await db.select().from(userSettings).limit(1);
  const raw = users[0]?.jarSizes;
  if (Array.isArray(raw)) {
    return raw as JarSize[];
  }
  return DEFAULT_JAR_SIZES;
}

export async function updateJarSizes(sizes: JarSize[]) {
  const users = await db.select().from(userSettings).limit(1);
  if (!users[0]) return { error: "No user settings found" };

  await db
    .update(userSettings)
    .set({ jarSizes: sizes, updatedAt: new Date() })
    .where(eq(userSettings.id, users[0].id));

  revalidatePath("/settings/jar-sizes");
  revalidatePath("/harvest");
  return { success: true };
}
