"use server";

import { db } from "@/db";
import { inspections, hives, apiaries } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createInspection(
  _prevState: unknown,
  formData: FormData
) {
  const hiveId = formData.get("hiveId") as string;
  const date = formData.get("date") as string;
  const inspectorName = formData.get("inspectorName") as string;
  const queenSeen = formData.get("queenSeen") === "true";
  const queenHealth = formData.get("queenHealth") as string;
  const broodPattern = formData.get("broodPattern") as string;
  const storesHoney = formData.get("storesHoney") as string;
  const storesPollen = formData.get("storesPollen") as string;
  const temperament = formData.get("temperament") as string;
  const pestsJson = formData.get("pests") as string;
  const treatmentsJson = formData.get("treatments") as string;
  const notes = formData.get("notes") as string;

  if (!hiveId) {
    return { error: "Hive is required" };
  }
  if (!date) {
    return { error: "Date is required" };
  }

  await db
    .insert(inspections)
    .values({
      hiveId,
      date: new Date(date),
      inspectorName: inspectorName?.trim() || null,
      queenSeen: queenSeen || null,
      queenHealth: queenHealth?.trim() || null,
      broodPattern: broodPattern?.trim() || null,
      storesHoney: storesHoney ? parseInt(storesHoney) : null,
      storesPollen: storesPollen ? parseInt(storesPollen) : null,
      temperament: temperament ? parseInt(temperament) : null,
      pests: pestsJson ? JSON.parse(pestsJson) : null,
      treatments: treatmentsJson ? JSON.parse(treatmentsJson) : null,
      notes: notes?.trim() || null,
    })
    .returning();

  revalidatePath(`/hives/${hiveId}`);
  revalidatePath("/dashboard");
  redirect(`/hives/${hiveId}`);
}

export async function updateInspection(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  const date = formData.get("date") as string;
  const inspectorName = formData.get("inspectorName") as string;
  const queenSeen = formData.get("queenSeen") === "true";
  const queenHealth = formData.get("queenHealth") as string;
  const broodPattern = formData.get("broodPattern") as string;
  const storesHoney = formData.get("storesHoney") as string;
  const storesPollen = formData.get("storesPollen") as string;
  const temperament = formData.get("temperament") as string;
  const pestsJson = formData.get("pests") as string;
  const treatmentsJson = formData.get("treatments") as string;
  const notes = formData.get("notes") as string;

  if (!date) {
    return { error: "Date is required" };
  }

  // Get hiveId for revalidation
  const existing = await db
    .select({ hiveId: inspections.hiveId })
    .from(inspections)
    .where(eq(inspections.id, id))
    .limit(1);
  const hiveId = existing[0]?.hiveId;

  await db
    .update(inspections)
    .set({
      date: new Date(date),
      inspectorName: inspectorName?.trim() || null,
      queenSeen: queenSeen || null,
      queenHealth: queenHealth?.trim() || null,
      broodPattern: broodPattern?.trim() || null,
      storesHoney: storesHoney ? parseInt(storesHoney) : null,
      storesPollen: storesPollen ? parseInt(storesPollen) : null,
      temperament: temperament ? parseInt(temperament) : null,
      pests: pestsJson ? JSON.parse(pestsJson) : null,
      treatments: treatmentsJson ? JSON.parse(treatmentsJson) : null,
      notes: notes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(inspections.id, id));

  if (hiveId) {
    revalidatePath(`/hives/${hiveId}`);
  }
  revalidatePath("/dashboard");
  redirect(`/hives/${hiveId}`);
}

export async function deleteInspection(id: string) {
  const existing = await db
    .select({ hiveId: inspections.hiveId })
    .from(inspections)
    .where(eq(inspections.id, id))
    .limit(1);
  const hiveId = existing[0]?.hiveId;

  await db.delete(inspections).where(eq(inspections.id, id));

  if (hiveId) {
    revalidatePath(`/hives/${hiveId}`);
  }
  revalidatePath("/dashboard");
  redirect(`/hives/${hiveId}`);
}

export async function getInspectionsForHive(hiveId: string) {
  return db
    .select()
    .from(inspections)
    .where(eq(inspections.hiveId, hiveId))
    .orderBy(desc(inspections.date));
}

export async function getInspection(id: string) {
  const result = await db
    .select()
    .from(inspections)
    .where(eq(inspections.id, id))
    .limit(1);
  return result[0] || null;
}

export async function getRecentInspections(limit = 10) {
  return db
    .select({
      id: inspections.id,
      hiveId: inspections.hiveId,
      date: inspections.date,
      queenSeen: inspections.queenSeen,
      notes: inspections.notes,
      hiveName: hives.positionLabel,
      apiaryName: apiaries.name,
    })
    .from(inspections)
    .innerJoin(hives, eq(inspections.hiveId, hives.id))
    .innerJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .orderBy(desc(inspections.date))
    .limit(limit);
}
