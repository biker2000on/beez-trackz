"use server";

import { requireSession } from "@/lib/require-session";
import { formValues, normalizeFormData } from "@/lib/form-values";
import { db } from "@/db";
import { inspections, feedings } from "@/db/schema";
import { revalidatePath } from "next/cache";

export async function bulkCreateInspections(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
  const hiveIdsJson = formData.get("hiveIds") as string;
  const date = formData.get("date") as string;
  const notes = formData.get("notes") as string;

  if (!hiveIdsJson || !date) return { error: "Hives and date are required", values: formValues(formData) };

  const hiveIds: string[] = JSON.parse(hiveIdsJson);
  if (hiveIds.length === 0) return { error: "Select at least one hive", values: formValues(formData) };

  await db.transaction(async (tx) => {
    for (const hiveId of hiveIds) {
      await tx.insert(inspections).values({
        hiveId,
        date: new Date(date),
        notes: notes?.trim() || null,
      });
    }
  });

  revalidatePath("/dashboard");
  return { success: true, count: hiveIds.length };
}

export async function bulkCreateFeedings(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
  const hiveIdsJson = formData.get("hiveIds") as string;
  const dateFed = formData.get("dateFed") as string;
  const type = formData.get("type") as string;
  const quantity = formData.get("quantity") as string;
  const quantityUnit = formData.get("quantityUnit") as string;
  const feederType = formData.get("feederType") as string;
  const notes = formData.get("notes") as string;

  if (!hiveIdsJson || !dateFed || !type || !quantity || !quantityUnit) {
    return { error: "Required fields missing", values: formValues(formData) };
  }

  const hiveIds: string[] = JSON.parse(hiveIdsJson);
  if (hiveIds.length === 0) return { error: "Select at least one hive", values: formValues(formData) };

  await db.transaction(async (tx) => {
    for (const hiveId of hiveIds) {
      await tx.insert(feedings).values({
        hiveId,
        dateFed: new Date(dateFed),
        type: type as (typeof feedings.$inferInsert)["type"],
        quantity: parseFloat(quantity),
        quantityUnit: quantityUnit as (typeof feedings.$inferInsert)["quantityUnit"],
        feederType: feederType && feederType !== "__none__"
          ? (feederType as (typeof feedings.$inferInsert)["feederType"])
          : null,
        notes: notes?.trim() || null,
      });
    }
  });

  revalidatePath("/dashboard");
  return { success: true, count: hiveIds.length };
}
