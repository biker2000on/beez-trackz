"use server";

import { requireSession } from "@/lib/require-session";
import { formValues, normalizeFormData } from "@/lib/form-values";
import { db } from "@/db";
import { hiveSplits, hives, hiveLocationHistory } from "@/db/schema";
import { eq, or, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createSplit(_prevState: unknown, formData: FormData) {
  await requireSession();
  formData = normalizeFormData(formData);
  const parentHiveId = formData.get("parentHiveId") as string;
  const apiaryId = formData.get("apiaryId") as string;
  const positionLabel = formData.get("positionLabel") as string;
  const splitDate = formData.get("splitDate") as string;
  const splitType = formData.get("splitType") as string;
  const framesMoved = formData.get("framesMoved") as string;
  const notes = formData.get("notes") as string;

  if (!parentHiveId || !apiaryId || !positionLabel || !splitDate || !splitType) {
    return { error: "Parent hive, apiary, position, date, and split type are required", values: formValues(formData) };
  }

  const result = await db.transaction(async (tx) => {
    // Create child hive
    const [childHive] = await tx.insert(hives).values({
      apiaryId,
      positionLabel: positionLabel.trim(),
      status: "active",
      installedDate: new Date(splitDate),
    }).returning();

    // Create location history for child
    await tx.insert(hiveLocationHistory).values({
      hiveId: childHive.id,
      apiaryId,
      positionLabel: positionLabel.trim(),
      dateFrom: new Date(splitDate),
    });

    // Record the split
    await tx.insert(hiveSplits).values({
      parentHiveId,
      childHiveId: childHive.id,
      splitDate: new Date(splitDate),
      splitType: splitType as "walk-away" | "vertical" | "nuc" | "cutdown" | "other",
      framesMoved: framesMoved ? parseInt(framesMoved) : null,
      notes: notes?.trim() || null,
    });

    return childHive;
  });

  revalidatePath("/hives");
  revalidatePath(`/hives/${parentHiveId}`);
  redirect(`/hives/${result.id}`);
}

export async function getSplitsForHive(hiveId: string) {
  await requireSession();
  // Get splits as both parent and child
  const splits = await db
    .select({
      id: hiveSplits.id,
      parentHiveId: hiveSplits.parentHiveId,
      childHiveId: hiveSplits.childHiveId,
      splitDate: hiveSplits.splitDate,
      splitType: hiveSplits.splitType,
      framesMoved: hiveSplits.framesMoved,
      notes: hiveSplits.notes,
    })
    .from(hiveSplits)
    .where(or(eq(hiveSplits.parentHiveId, hiveId), eq(hiveSplits.childHiveId, hiveId)))
    .orderBy(desc(hiveSplits.splitDate));

  // Enrich with hive labels
  const hiveIds = new Set<string>();
  splits.forEach(s => { hiveIds.add(s.parentHiveId); hiveIds.add(s.childHiveId); });

  const hiveLabels: Record<string, string> = {};
  if (hiveIds.size > 0) {
    const hiveData = await db.select({ id: hives.id, positionLabel: hives.positionLabel }).from(hives);
    hiveData.forEach(h => { hiveLabels[h.id] = h.positionLabel; });
  }

  return splits.map(s => ({
    ...s,
    parentLabel: hiveLabels[s.parentHiveId] || "Unknown",
    childLabel: hiveLabels[s.childHiveId] || "Unknown",
  }));
}

export async function deleteSplit(id: string) {
  await requireSession();
  await db.delete(hiveSplits).where(eq(hiveSplits.id, id));
  revalidatePath("/hives");
}
