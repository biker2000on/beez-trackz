"use server";

import { requireSession } from "@/lib/require-session";
import { formValues } from "@/lib/form-values";
import { db } from "@/db";
import { feedings, hives, apiaries } from "@/db/schema";
import { eq, isNull, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createFeeding(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  const hiveId = formData.get("hiveId") as string;
  const dateFed = formData.get("dateFed") as string;
  const type = formData.get("type") as string;
  const quantity = formData.get("quantity") as string;
  const quantityUnit = formData.get("quantityUnit") as string;
  const feederType = formData.get("feederType") as string;
  const notes = formData.get("notes") as string;

  if (!hiveId) {
    return { error: "Hive is required", values: formValues(formData) };
  }
  if (!dateFed) {
    return { error: "Date is required", values: formValues(formData) };
  }
  if (!type) {
    return { error: "Feed type is required", values: formValues(formData) };
  }
  if (!quantity) {
    return { error: "Quantity is required", values: formValues(formData) };
  }
  if (!quantityUnit) {
    return { error: "Unit is required", values: formValues(formData) };
  }

  await db.insert(feedings).values({
    hiveId,
    dateFed: new Date(dateFed),
    type: type as (typeof feedings.$inferInsert)["type"],
    quantity: parseFloat(quantity),
    quantityUnit: quantityUnit as (typeof feedings.$inferInsert)["quantityUnit"],
    feederType: feederType
      ? (feederType as (typeof feedings.$inferInsert)["feederType"])
      : null,
    notes: notes?.trim() || null,
  });

  revalidatePath(`/hives/${hiveId}`);
  revalidatePath("/dashboard");
  redirect(`/hives/${hiveId}`);
}

export async function markFeedingEmpty(id: string) {
  await requireSession();
  const existing = await db
    .select({ hiveId: feedings.hiveId })
    .from(feedings)
    .where(eq(feedings.id, id))
    .limit(1);

  await db
    .update(feedings)
    .set({ dateEmpty: new Date() })
    .where(eq(feedings.id, id));

  if (existing[0]?.hiveId) {
    revalidatePath(`/hives/${existing[0].hiveId}`);
  }
  revalidatePath("/dashboard");
}

export async function deleteFeeding(id: string) {
  await requireSession();
  const existing = await db
    .select({ hiveId: feedings.hiveId })
    .from(feedings)
    .where(eq(feedings.id, id))
    .limit(1);
  const hiveId = existing[0]?.hiveId;

  await db.delete(feedings).where(eq(feedings.id, id));

  if (hiveId) {
    revalidatePath(`/hives/${hiveId}`);
  }
  revalidatePath("/dashboard");
  redirect(hiveId ? `/hives/${hiveId}` : "/hives");
}

export async function getFeedingsForHive(hiveId: string) {
  await requireSession();
  return db
    .select()
    .from(feedings)
    .where(eq(feedings.hiveId, hiveId))
    .orderBy(desc(feedings.dateFed));
}

export async function getActiveFeedings() {
  await requireSession();
  return db
    .select({
      id: feedings.id,
      hiveId: feedings.hiveId,
      dateFed: feedings.dateFed,
      type: feedings.type,
      quantity: feedings.quantity,
      quantityUnit: feedings.quantityUnit,
      feederType: feedings.feederType,
      hiveName: hives.positionLabel,
      apiaryName: apiaries.name,
    })
    .from(feedings)
    .innerJoin(hives, eq(feedings.hiveId, hives.id))
    .innerJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .where(isNull(feedings.dateEmpty))
    .orderBy(feedings.dateFed);
}
