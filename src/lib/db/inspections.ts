import { db } from "@/db";
import { inspections } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Shared inspection persistence used by both the server actions (form
 * submissions) and the offline sync API route, so the two paths can't
 * drift apart.
 */

export interface InspectionRecordInput {
  hiveId: string;
  date: Date;
  inspectorName?: string | null;
  queenSeen?: boolean | null;
  queenHealth?: string | null;
  broodPattern?: string | null;
  storesHoney?: number | null;
  storesPollen?: number | null;
  temperament?: number | null;
  pests?: unknown;
  treatments?: unknown;
  notes?: string | null;
}

export async function createInspectionRecord(input: InspectionRecordInput) {
  const [record] = await db
    .insert(inspections)
    .values({
      hiveId: input.hiveId,
      date: input.date,
      inspectorName: input.inspectorName ?? null,
      queenSeen: input.queenSeen ?? null,
      queenHealth: input.queenHealth ?? null,
      broodPattern: input.broodPattern ?? null,
      storesHoney: input.storesHoney ?? null,
      storesPollen: input.storesPollen ?? null,
      temperament: input.temperament ?? null,
      pests: input.pests ?? null,
      treatments: input.treatments ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return record;
}

export async function updateInspectionRecord(
  id: string,
  fields: Partial<Omit<InspectionRecordInput, "hiveId">>
) {
  await db
    .update(inspections)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(inspections.id, id));
}

export async function deleteInspectionRecord(id: string) {
  await db.delete(inspections).where(eq(inspections.id, id));
}
