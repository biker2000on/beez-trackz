"use server";

import { requireSession } from "@/lib/require-session";
import { formValues } from "@/lib/form-values";
import { db } from "@/db";
import { bloomObservations } from "@/db/schema";
import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createBloomObservation(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  const apiaryId = formData.get("apiaryId") as string;
  const species = formData.get("species") as string;
  const dateFirstSeen = formData.get("dateFirstSeen") as string;
  const abundance = formData.get("abundance") as string;
  const notes = formData.get("notes") as string;

  if (!apiaryId || !species || !dateFirstSeen) {
    return { error: "Apiary, species, and date are required", values: formValues(formData) };
  }

  const year = new Date(dateFirstSeen).getFullYear();

  await db.insert(bloomObservations).values({
    apiaryId,
    species: species.trim(),
    dateFirstSeen,
    year,
    abundance: abundance && abundance !== "__none__" ? parseInt(abundance) : null,
    notes: notes?.trim() || null,
  });

  revalidatePath(`/apiaries/${apiaryId}`);
  return { success: true };
}

export async function endBloom(id: string, apiaryId: string) {
  await requireSession();
  const today = new Date().toISOString().split("T")[0];
  await db
    .update(bloomObservations)
    .set({ dateLastSeen: today })
    .where(eq(bloomObservations.id, id));

  revalidatePath(`/apiaries/${apiaryId}`);
}

export async function updateBloomLastSeen(id: string, apiaryId: string) {
  await requireSession();
  const today = new Date().toISOString().split("T")[0];
  await db
    .update(bloomObservations)
    .set({ dateLastSeen: today })
    .where(eq(bloomObservations.id, id));

  revalidatePath(`/apiaries/${apiaryId}`);
}

export async function deleteBloomObservation(id: string, apiaryId: string) {
  await requireSession();
  await db.delete(bloomObservations).where(eq(bloomObservations.id, id));
  revalidatePath(`/apiaries/${apiaryId}`);
}

export async function getActiveBloomsForApiary(apiaryId: string) {
  await requireSession();
  return db
    .select()
    .from(bloomObservations)
    .where(
      and(
        eq(bloomObservations.apiaryId, apiaryId),
        isNull(bloomObservations.dateLastSeen)
      )
    )
    .orderBy(desc(bloomObservations.dateFirstSeen));
}

export async function getBloomHistoryForApiary(apiaryId: string) {
  await requireSession();
  return db
    .select()
    .from(bloomObservations)
    .where(eq(bloomObservations.apiaryId, apiaryId))
    .orderBy(desc(bloomObservations.year), desc(bloomObservations.dateFirstSeen));
}

export async function getBloomSpeciesAutocomplete(apiaryId: string) {
  await requireSession();
  const result = await db
    .select({ species: bloomObservations.species })
    .from(bloomObservations)
    .where(eq(bloomObservations.apiaryId, apiaryId))
    .groupBy(bloomObservations.species)
    .orderBy(desc(sql`max(${bloomObservations.dateFirstSeen})`));

  return result.map((r) => r.species);
}
