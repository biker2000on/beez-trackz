"use server";

import { requireSession } from "@/lib/require-session";
import { formValues, normalizeFormData } from "@/lib/form-values";
import { db } from "@/db";
import { inspections, hives, apiaries } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createInspectionRecord,
  updateInspectionRecord,
  deleteInspectionRecord,
} from "@/lib/db/inspections";

function parseOptionalInt(value: string): number | null {
  if (!value || value === "__none__") return null;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function createInspection(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
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
    return { error: "Hive is required", values: formValues(formData) };
  }
  if (!date) {
    return { error: "Date is required", values: formValues(formData) };
  }

  await createInspectionRecord({
    hiveId,
    date: new Date(date),
    inspectorName: inspectorName?.trim() || null,
    queenSeen: queenSeen || null,
    queenHealth: queenHealth?.trim() || null,
    broodPattern: broodPattern?.trim() || null,
    storesHoney: parseOptionalInt(storesHoney),
    storesPollen: parseOptionalInt(storesPollen),
    temperament: parseOptionalInt(temperament),
    pests: pestsJson ? safeJsonParse(pestsJson) : null,
    treatments: treatmentsJson ? safeJsonParse(treatmentsJson) : null,
    notes: notes?.trim() || null,
  });

  revalidatePath(`/hives/${hiveId}`);
  revalidatePath("/dashboard");
  redirect(`/hives/${hiveId}`);
}

export async function updateInspection(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
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
    return { error: "Date is required", values: formValues(formData) };
  }

  // Get hiveId for revalidation
  const existing = await db
    .select({ hiveId: inspections.hiveId })
    .from(inspections)
    .where(eq(inspections.id, id))
    .limit(1);
  const hiveId = existing[0]?.hiveId;

  await updateInspectionRecord(id, {
    date: new Date(date),
    inspectorName: inspectorName?.trim() || null,
    queenSeen: queenSeen || null,
    queenHealth: queenHealth?.trim() || null,
    broodPattern: broodPattern?.trim() || null,
    storesHoney: parseOptionalInt(storesHoney),
    storesPollen: parseOptionalInt(storesPollen),
    temperament: parseOptionalInt(temperament),
    pests: pestsJson ? safeJsonParse(pestsJson) : null,
    treatments: treatmentsJson ? safeJsonParse(treatmentsJson) : null,
    notes: notes?.trim() || null,
  });

  if (hiveId) {
    revalidatePath(`/hives/${hiveId}`);
  }
  revalidatePath("/dashboard");
  redirect(hiveId ? `/hives/${hiveId}` : "/hives");
}

export async function deleteInspection(id: string) {
  await requireSession();
  const existing = await db
    .select({ hiveId: inspections.hiveId })
    .from(inspections)
    .where(eq(inspections.id, id))
    .limit(1);
  const hiveId = existing[0]?.hiveId;

  await deleteInspectionRecord(id);

  if (hiveId) {
    revalidatePath(`/hives/${hiveId}`);
  }
  revalidatePath("/dashboard");
  revalidatePath("/hives");
}

export async function getInspectionsForHive(hiveId: string) {
  await requireSession();
  return db
    .select()
    .from(inspections)
    .where(eq(inspections.hiveId, hiveId))
    .orderBy(desc(inspections.date));
}

export async function getInspection(id: string) {
  await requireSession();
  const result = await db
    .select()
    .from(inspections)
    .where(eq(inspections.id, id))
    .limit(1);
  return result[0] || null;
}

export async function getRecentInspections(limit = 10) {
  await requireSession();
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
