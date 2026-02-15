"use server";

import { db } from "@/db";
import { equipment, hives, apiaries } from "@/db/schema";
import { eq, isNull, sql, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createEquipment(_prevState: unknown, formData: FormData) {
  const type = formData.get("type") as string;
  const frameCapacity = formData.get("frameCapacity") as string;
  const framesInstalled = formData.get("framesInstalled") as string;
  const frameType = formData.get("frameType") as string;
  const hiveId = formData.get("hiveId") as string;
  const storageLocation = formData.get("storageLocation") as string;

  if (!type) {
    return { error: "Equipment type is required" };
  }

  await db.insert(equipment).values({
    type: type as any,
    frameCapacity: frameCapacity ? parseInt(frameCapacity) : null,
    framesInstalled: framesInstalled ? parseInt(framesInstalled) : null,
    frameType: frameType ? (frameType as any) : null,
    hiveId: hiveId || null,
    storageLocation: storageLocation?.trim() || null,
    addedToHiveDate: hiveId ? new Date() : null,
  });

  revalidatePath("/settings/equipment");
  if (hiveId) revalidatePath(`/hives/${hiveId}`);
  redirect(hiveId ? `/hives/${hiveId}` : "/settings/equipment");
}

export async function updateEquipment(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  const type = formData.get("type") as string;
  const frameCapacity = formData.get("frameCapacity") as string;
  const framesInstalled = formData.get("framesInstalled") as string;
  const frameType = formData.get("frameType") as string;
  const storageLocation = formData.get("storageLocation") as string;

  if (!type) {
    return { error: "Equipment type is required" };
  }

  await db
    .update(equipment)
    .set({
      type: type as any,
      frameCapacity: frameCapacity ? parseInt(frameCapacity) : null,
      framesInstalled: framesInstalled ? parseInt(framesInstalled) : null,
      frameType: frameType ? (frameType as any) : null,
      storageLocation: storageLocation?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(equipment.id, id));

  revalidatePath("/settings/equipment");
  redirect("/settings/equipment");
}

export async function deleteEquipment(id: string) {
  await db.delete(equipment).where(eq(equipment.id, id));
  revalidatePath("/settings/equipment");
  redirect("/settings/equipment");
}

// Move equipment to a hive or back to storage
export async function moveEquipment(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  const hiveId = formData.get("hiveId") as string;
  const storageLocation = formData.get("storageLocation") as string;

  if (hiveId) {
    // Moving to a hive
    await db
      .update(equipment)
      .set({
        hiveId,
        storageLocation: null,
        addedToHiveDate: new Date(),
        removedFromHiveDate: null,
        updatedAt: new Date(),
      })
      .where(eq(equipment.id, id));
    revalidatePath(`/hives/${hiveId}`);
  } else {
    // Moving to storage
    await db
      .update(equipment)
      .set({
        hiveId: null,
        storageLocation: storageLocation?.trim() || "Unspecified",
        removedFromHiveDate: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(equipment.id, id));
  }

  revalidatePath("/settings/equipment");
  redirect("/settings/equipment");
}

// Get equipment for a specific hive — ordered as a stack (most recently added on top)
export async function getEquipmentForHive(hiveId: string) {
  return db
    .select()
    .from(equipment)
    .where(eq(equipment.hiveId, hiveId))
    .orderBy(desc(equipment.addedToHiveDate));
}

// Get equipment in storage (not on any hive)
export async function getEquipmentInStorage() {
  return db
    .select()
    .from(equipment)
    .where(isNull(equipment.hiveId))
    .orderBy(equipment.type);
}

// Get all equipment with hive and apiary info
export async function getAllEquipment() {
  return db
    .select({
      id: equipment.id,
      type: equipment.type,
      frameCapacity: equipment.frameCapacity,
      framesInstalled: equipment.framesInstalled,
      frameType: equipment.frameType,
      hiveId: equipment.hiveId,
      storageLocation: equipment.storageLocation,
      addedToHiveDate: equipment.addedToHiveDate,
      removedFromHiveDate: equipment.removedFromHiveDate,
      hiveName: hives.positionLabel,
      apiaryName: apiaries.name,
    })
    .from(equipment)
    .leftJoin(hives, eq(equipment.hiveId, hives.id))
    .leftJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .orderBy(equipment.type);
}

// Frame shortage aggregate
export async function getFrameShortage() {
  const result = await db
    .select({
      type: equipment.type,
      frameType: equipment.frameType,
      totalCapacity: sql<number>`coalesce(sum(${equipment.frameCapacity}), 0)`,
      totalInstalled: sql<number>`coalesce(sum(${equipment.framesInstalled}), 0)`,
    })
    .from(equipment)
    .where(sql`${equipment.frameCapacity} is not null`)
    .groupBy(equipment.type, equipment.frameType);

  const summary = {
    totalCapacity: 0,
    totalInstalled: 0,
    shortage: 0,
    breakdown: result.map((r) => ({
      boxType: r.type,
      frameType: r.frameType,
      capacity: Number(r.totalCapacity),
      installed: Number(r.totalInstalled),
      shortage: Number(r.totalCapacity) - Number(r.totalInstalled),
    })),
  };

  for (const row of summary.breakdown) {
    summary.totalCapacity += row.capacity;
    summary.totalInstalled += row.installed;
  }
  summary.shortage = summary.totalCapacity - summary.totalInstalled;

  return summary;
}
