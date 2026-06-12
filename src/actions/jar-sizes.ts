"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { jarSizes } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export interface JarSizeRecord {
  id: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  sortOrder: number;
  isActive: boolean;
}

const DEFAULT_JAR_SIZES = [
  { label: "Half Pint", honeyOz: 12 },
  { label: "Pint", honeyOz: 22 },
  { label: "Quart", honeyOz: 44 },
  { label: "Half Gallon", honeyOz: 88 },
  { label: "Gallon", honeyOz: 176 },
];

/** All jar sizes, seeding the defaults on first use. */
export async function getJarSizes(includeInactive = false): Promise<JarSizeRecord[]> {
  await requireSession();
  let rows = await db.select().from(jarSizes).orderBy(asc(jarSizes.sortOrder), asc(jarSizes.label));
  if (rows.length === 0) {
    await db
      .insert(jarSizes)
      .values(DEFAULT_JAR_SIZES.map((s, i) => ({ ...s, sortOrder: i })))
      .onConflictDoNothing();
    rows = await db.select().from(jarSizes).orderBy(asc(jarSizes.sortOrder), asc(jarSizes.label));
  }
  return includeInactive ? rows : rows.filter((r) => r.isActive);
}

export async function createJarSize(data: {
  label: string;
  honeyOz?: number | null;
  defaultPrice?: number | null;
}) {
  await requireSession();
  const label = data.label.trim();
  if (!label) return { error: "Label is required" };
  const existing = await db.select().from(jarSizes).where(eq(jarSizes.label, label)).limit(1);
  if (existing.length > 0) return { error: `"${label}" already exists` };

  const all = await db.select({ sortOrder: jarSizes.sortOrder }).from(jarSizes);
  const maxOrder = all.reduce((m, r) => Math.max(m, r.sortOrder), -1);

  await db.insert(jarSizes).values({
    label,
    honeyOz: data.honeyOz ?? null,
    defaultPrice: data.defaultPrice ?? null,
    sortOrder: maxOrder + 1,
  });
  revalidatePath("/settings/jar-sizes");
  revalidatePath("/harvest");
  return { success: true };
}

export async function updateJarSize(
  id: string,
  data: { label?: string; honeyOz?: number | null; defaultPrice?: number | null; isActive?: boolean }
) {
  await requireSession();
  await db
    .update(jarSizes)
    .set({
      ...(data.label !== undefined ? { label: data.label.trim() } : {}),
      ...(data.honeyOz !== undefined ? { honeyOz: data.honeyOz } : {}),
      ...(data.defaultPrice !== undefined ? { defaultPrice: data.defaultPrice } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    })
    .where(eq(jarSizes.id, id));
  revalidatePath("/settings/jar-sizes");
  revalidatePath("/harvest");
  return { success: true };
}
