"use server";

import { db } from "@/db";
import { apiaries, hives } from "@/db/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createApiary(_prevState: unknown, formData: FormData) {
  const name = formData.get("name") as string;
  const latitude = formData.get("latitude") as string;
  const longitude = formData.get("longitude") as string;
  const notes = formData.get("notes") as string;

  if (!name?.trim()) {
    return { error: "Apiary name is required" };
  }

  const [apiary] = await db
    .insert(apiaries)
    .values({
      name: name.trim(),
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      notes: notes?.trim() || null,
    })
    .returning();

  revalidatePath("/apiaries");
  redirect(`/apiaries/${apiary.id}`);
}

export async function updateApiary(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  const name = formData.get("name") as string;
  const latitude = formData.get("latitude") as string;
  const longitude = formData.get("longitude") as string;
  const notes = formData.get("notes") as string;

  if (!name?.trim()) {
    return { error: "Apiary name is required" };
  }

  await db
    .update(apiaries)
    .set({
      name: name.trim(),
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      notes: notes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(apiaries.id, id));

  revalidatePath("/apiaries");
  revalidatePath(`/apiaries/${id}`);
  redirect(`/apiaries/${id}`);
}

export async function deleteApiary(id: string) {
  // Check for hives first
  const hiveCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(hives)
    .where(eq(hives.apiaryId, id));

  if (Number(hiveCount[0].count) > 0) {
    return {
      error:
        "Cannot delete apiary with active hives. Move or remove hives first.",
    };
  }

  await db.delete(apiaries).where(eq(apiaries.id, id));
  revalidatePath("/apiaries");
  redirect("/apiaries");
}

export async function getApiaries() {
  const result = await db
    .select({
      id: apiaries.id,
      name: apiaries.name,
      latitude: apiaries.latitude,
      longitude: apiaries.longitude,
      notes: apiaries.notes,
      createdAt: apiaries.createdAt,
      hiveCount: sql<number>`count(${hives.id})`,
    })
    .from(apiaries)
    .leftJoin(hives, and(
      eq(apiaries.id, hives.apiaryId),
      eq(hives.isArchived, false),
      isNull(hives.deadoutDate)
    ))
    .groupBy(apiaries.id)
    .orderBy(apiaries.name);

  return result;
}

export async function getApiary(id: string) {
  const result = await db
    .select()
    .from(apiaries)
    .where(eq(apiaries.id, id))
    .limit(1);

  return result[0] || null;
}
