"use server";

import { db } from "@/db";
import { hives, hiveLocationHistory, apiaries } from "@/db/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Create hive — also creates initial location history entry
export async function createHive(_prevState: unknown, formData: FormData) {
  const apiaryId = formData.get("apiaryId") as string;
  const positionLabel = formData.get("positionLabel") as string;
  const status = formData.get("status") as string;
  const installedDate = formData.get("installedDate") as string;
  const notes = formData.get("notes") as string;

  if (!apiaryId) {
    return { error: "Apiary is required" };
  }
  if (!positionLabel?.trim()) {
    return { error: "Position label is required" };
  }

  const [hive] = await db.transaction(async (tx) => {
    const [newHive] = await tx
      .insert(hives)
      .values({
        apiaryId,
        positionLabel: positionLabel.trim(),
        status: (status as "active" | "dead" | "sold" | "combined") || "active",
        installedDate: installedDate ? new Date(installedDate) : null,
        notes: notes?.trim() || null,
      })
      .returning();

    // Create initial location history entry
    await tx.insert(hiveLocationHistory).values({
      hiveId: newHive.id,
      apiaryId,
      positionLabel: positionLabel.trim(),
      dateFrom: newHive.installedDate || new Date(),
    });

    return [newHive];
  });

  revalidatePath("/hives");
  revalidatePath(`/apiaries/${apiaryId}`);
  redirect(`/hives/${hive.id}`);
}

// Update hive details (not location)
export async function updateHive(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  const positionLabel = formData.get("positionLabel") as string;
  const status = formData.get("status") as string;
  const installedDate = formData.get("installedDate") as string;
  const notes = formData.get("notes") as string;

  if (!positionLabel?.trim()) {
    return { error: "Position label is required" };
  }

  await db
    .update(hives)
    .set({
      positionLabel: positionLabel.trim(),
      status: (status as "active" | "dead" | "sold" | "combined") || "active",
      installedDate: installedDate ? new Date(installedDate) : null,
      notes: notes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(hives.id, id));

  revalidatePath("/hives");
  revalidatePath(`/hives/${id}`);
  redirect(`/hives/${id}`);
}

// Move hive to a new apiary/position — closes current location record, opens new one
export async function moveHive(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  const newApiaryId = formData.get("apiaryId") as string;
  const newPositionLabel = formData.get("positionLabel") as string;

  if (!newApiaryId) {
    return { error: "New apiary is required" };
  }
  if (!newPositionLabel?.trim()) {
    return { error: "New position label is required" };
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    // Close current location record
    await tx
      .update(hiveLocationHistory)
      .set({ dateTo: now })
      .where(
        and(
          eq(hiveLocationHistory.hiveId, id),
          isNull(hiveLocationHistory.dateTo)
        )
      );

    // Open new location record
    await tx.insert(hiveLocationHistory).values({
      hiveId: id,
      apiaryId: newApiaryId,
      positionLabel: newPositionLabel.trim(),
      dateFrom: now,
    });

    // Update hive's current apiary and position
    await tx
      .update(hives)
      .set({
        apiaryId: newApiaryId,
        positionLabel: newPositionLabel.trim(),
        updatedAt: now,
      })
      .where(eq(hives.id, id));
  });

  revalidatePath("/hives");
  revalidatePath(`/hives/${id}`);
  redirect(`/hives/${id}`);
}

// Delete hive
export async function deleteHive(id: string) {
  // First delete location history
  await db
    .delete(hiveLocationHistory)
    .where(eq(hiveLocationHistory.hiveId, id));
  // Then delete the hive
  await db.delete(hives).where(eq(hives.id, id));

  revalidatePath("/hives");
  redirect("/hives");
}

// Get all hives with apiary info
export async function getHives(apiaryId?: string, status?: string) {
  const query = db
    .select({
      id: hives.id,
      positionLabel: hives.positionLabel,
      status: hives.status,
      installedDate: hives.installedDate,
      notes: hives.notes,
      apiaryId: hives.apiaryId,
      apiaryName: apiaries.name,
      createdAt: hives.createdAt,
    })
    .from(hives)
    .innerJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .orderBy(apiaries.name, hives.positionLabel);

  const conditions = [];
  if (apiaryId) {
    conditions.push(eq(hives.apiaryId, apiaryId));
  }
  if (status) {
    conditions.push(eq(hives.status, status as "active" | "dead" | "sold" | "combined"));
  }

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

// Get hives for a specific apiary (used in apiary detail page)
export async function getHivesForApiary(apiaryId: string) {
  return getHives(apiaryId);
}

// Get single hive with full details
export async function getHive(id: string) {
  const result = await db
    .select({
      id: hives.id,
      positionLabel: hives.positionLabel,
      status: hives.status,
      installedDate: hives.installedDate,
      notes: hives.notes,
      apiaryId: hives.apiaryId,
      apiaryName: apiaries.name,
      createdAt: hives.createdAt,
      updatedAt: hives.updatedAt,
    })
    .from(hives)
    .innerJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .where(eq(hives.id, id))
    .limit(1);

  return result[0] || null;
}

// Get location history for a hive
export async function getHiveLocationHistory(hiveId: string) {
  return db
    .select({
      id: hiveLocationHistory.id,
      apiaryId: hiveLocationHistory.apiaryId,
      apiaryName: apiaries.name,
      positionLabel: hiveLocationHistory.positionLabel,
      dateFrom: hiveLocationHistory.dateFrom,
      dateTo: hiveLocationHistory.dateTo,
    })
    .from(hiveLocationHistory)
    .innerJoin(apiaries, eq(hiveLocationHistory.apiaryId, apiaries.id))
    .where(eq(hiveLocationHistory.hiveId, hiveId))
    .orderBy(desc(hiveLocationHistory.dateFrom));
}
