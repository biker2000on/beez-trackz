"use server";

import { requireSession } from "@/lib/require-session";
import { formValues } from "@/lib/form-values";
import { db } from "@/db";
import { harvestSessions, honeyHarvests, hives, apiaries } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createHarvestSession(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  const apiaryId = formData.get("apiaryId") as string;
  const date = formData.get("date") as string;
  const notes = formData.get("notes") as string;

  if (!apiaryId) return { error: "Apiary is required", values: formValues(formData) };
  if (!date) return { error: "Date is required", values: formValues(formData) };

  const [session] = await db
    .insert(harvestSessions)
    .values({
      apiaryId,
      date: new Date(date),
      notes: notes?.trim() || null,
    })
    .returning();

  revalidatePath("/harvest");
  redirect(`/harvest/sessions/${session.id}`);
}

export async function addHarvestEntry(
  sessionId: string,
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  const hiveId = formData.get("hiveId") as string;
  const superWeightBefore = formData.get("superWeightBefore") as string;
  const superWeightAfter = formData.get("superWeightAfter") as string;
  const notes = formData.get("notes") as string;

  if (!hiveId) return { error: "Hive is required", values: formValues(formData) };
  if (!superWeightBefore || !superWeightAfter) return { error: "Both weights are required", values: formValues(formData) };

  const before = parseFloat(superWeightBefore);
  const after = parseFloat(superWeightAfter);
  const honeyWeight = before - after;

  if (honeyWeight < 0) return { error: "Weight before must be greater than weight after", values: formValues(formData) };

  const session = await db
    .select({ date: harvestSessions.date })
    .from(harvestSessions)
    .where(eq(harvestSessions.id, sessionId))
    .limit(1);

  if (!session[0]) return { error: "Session not found", values: formValues(formData) };

  await db.insert(honeyHarvests).values({
    sessionId,
    hiveId,
    date: session[0].date,
    superWeightBefore: before,
    superWeightAfter: after,
    calculatedHoneyWeight: honeyWeight,
    notes: notes?.trim() || null,
  });

  revalidatePath(`/harvest/sessions/${sessionId}`);
  return { success: true };
}

export async function trueUpHarvestSession(
  sessionId: string,
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  const totalWeight = formData.get("totalExtractedWeight") as string;

  if (!totalWeight) return { error: "Total weight is required", values: formValues(formData) };

  await db
    .update(harvestSessions)
    .set({ totalExtractedWeight: parseFloat(totalWeight) })
    .where(eq(harvestSessions.id, sessionId));

  revalidatePath(`/harvest/sessions/${sessionId}`);
  revalidatePath("/harvest");
  redirect(`/harvest/sessions/${sessionId}`);
}

export async function deleteHarvestEntry(entryId: string, sessionId: string) {
  await requireSession();
  await db.delete(honeyHarvests).where(eq(honeyHarvests.id, entryId));
  revalidatePath(`/harvest/sessions/${sessionId}`);
}

export async function getHarvestSession(id: string) {
  await requireSession();
  const session = await db
    .select()
    .from(harvestSessions)
    .where(eq(harvestSessions.id, id))
    .limit(1);

  if (!session[0]) return null;

  const entries = await db
    .select({
      id: honeyHarvests.id,
      hiveId: honeyHarvests.hiveId,
      superWeightBefore: honeyHarvests.superWeightBefore,
      superWeightAfter: honeyHarvests.superWeightAfter,
      calculatedHoneyWeight: honeyHarvests.calculatedHoneyWeight,
      notes: honeyHarvests.notes,
      hiveName: hives.positionLabel,
    })
    .from(honeyHarvests)
    .innerJoin(hives, eq(honeyHarvests.hiveId, hives.id))
    .where(eq(honeyHarvests.sessionId, id))
    .orderBy(honeyHarvests.createdAt);

  const calculatedTotal = entries.reduce((sum, e) => sum + e.calculatedHoneyWeight, 0);

  return {
    ...session[0],
    entries,
    calculatedTotal,
    difference: session[0].totalExtractedWeight
      ? calculatedTotal - session[0].totalExtractedWeight
      : null,
  };
}

export async function getHarvestSessions() {
  await requireSession();
  return db
    .select({
      id: harvestSessions.id,
      date: harvestSessions.date,
      totalExtractedWeight: harvestSessions.totalExtractedWeight,
      notes: harvestSessions.notes,
      apiaryName: apiaries.name,
      entryCount: sql<number>`cast(count(${honeyHarvests.id}) as integer)`,
      calculatedTotal: sql<number>`coalesce(sum(${honeyHarvests.calculatedHoneyWeight}), 0)`,
    })
    .from(harvestSessions)
    .innerJoin(apiaries, eq(harvestSessions.apiaryId, apiaries.id))
    .leftJoin(honeyHarvests, eq(honeyHarvests.sessionId, harvestSessions.id))
    .groupBy(harvestSessions.id, apiaries.name)
    .orderBy(desc(harvestSessions.date));
}
