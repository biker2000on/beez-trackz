"use server";

import { requireSession } from "@/lib/require-session";
import { formValues, normalizeFormData } from "@/lib/form-values";
import { db } from "@/db";
import { queens, hives, apiaries } from "@/db/schema";
import { eq, sql, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

type QueenOrigin = "purchased" | "swarm" | "raised" | "walked" | "emergency_cell" | "unknown";
type QueenStatus = "active" | "superseded" | "dead" | "missing";

export async function createQueen(_prevState: unknown, formData: FormData) {
  await requireSession();
  formData = normalizeFormData(formData);
  const hiveId = formData.get("hiveId") as string;
  const origin = formData.get("origin") as string;
  const originHiveId = formData.get("originHiveId") as string;
  const parentQueenId = formData.get("parentQueenId") as string;
  const introducedDate = formData.get("introducedDate") as string;
  const status = formData.get("status") as string;
  const notes = formData.get("notes") as string;

  if (!origin) {
    return { error: "Origin is required", values: formValues(formData) };
  }

  await db
    .insert(queens)
    .values({
      hiveId: hiveId && hiveId !== "__none__" ? hiveId : null,
      origin: origin as QueenOrigin,
      originHiveId: originHiveId && originHiveId !== "__none__" ? originHiveId : null,
      parentQueenId: parentQueenId && parentQueenId !== "__none__" ? parentQueenId : null,
      introducedDate: introducedDate ? new Date(introducedDate) : null,
      status: (status as QueenStatus) || "active",
      notes: notes?.trim() || null,
    })
    .returning();

  revalidatePath("/hives");
  if (hiveId && hiveId !== "__none__") {
    revalidatePath(`/hives/${hiveId}`);
  }
  revalidatePath("/genealogy");
  redirect(hiveId && hiveId !== "__none__" ? `/hives/${hiveId}` : "/genealogy");
}

export async function updateQueen(
  id: string,
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
  const hiveId = formData.get("hiveId") as string;
  const origin = formData.get("origin") as string;
  const originHiveId = formData.get("originHiveId") as string;
  const parentQueenId = formData.get("parentQueenId") as string;
  const introducedDate = formData.get("introducedDate") as string;
  const status = formData.get("status") as string;
  const notes = formData.get("notes") as string;

  if (!origin) {
    return { error: "Origin is required", values: formValues(formData) };
  }

  await db
    .update(queens)
    .set({
      hiveId: hiveId && hiveId !== "__none__" ? hiveId : null,
      origin: origin as QueenOrigin,
      originHiveId: originHiveId && originHiveId !== "__none__" ? originHiveId : null,
      parentQueenId: parentQueenId && parentQueenId !== "__none__" ? parentQueenId : null,
      introducedDate: introducedDate ? new Date(introducedDate) : null,
      status: (status as QueenStatus) || "active",
      notes: notes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(queens.id, id));

  revalidatePath("/hives");
  revalidatePath("/genealogy");
  redirect("/genealogy");
}

export async function getQueensForHive(hiveId: string) {
  await requireSession();
  return db
    .select()
    .from(queens)
    .where(eq(queens.hiveId, hiveId))
    .orderBy(desc(queens.introducedDate));
}

export async function getQueen(id: string) {
  await requireSession();
  const result = await db
    .select()
    .from(queens)
    .where(eq(queens.id, id))
    .limit(1);
  return result[0] || null;
}

// Get all queens for genealogy tree
export async function getAllQueens() {
  await requireSession();
  return db
    .select({
      id: queens.id,
      hiveId: queens.hiveId,
      origin: queens.origin,
      originHiveId: queens.originHiveId,
      parentQueenId: queens.parentQueenId,
      introducedDate: queens.introducedDate,
      status: queens.status,
      notes: queens.notes,
      hiveName: hives.positionLabel,
      apiaryName: apiaries.name,
    })
    .from(queens)
    .leftJoin(hives, eq(queens.hiveId, hives.id))
    .leftJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .orderBy(desc(queens.introducedDate));
}

// Get lineage (ancestors) for a specific queen
export async function getQueenLineage(queenId: string) {
  await requireSession();
  const result = await db.execute(sql`
    WITH RECURSIVE lineage AS (
      SELECT q.*, h.position_label as hive_name, a.name as apiary_name
      FROM queens q
      LEFT JOIN hives h ON q.hive_id = h.id
      LEFT JOIN apiaries a ON h.apiary_id = a.id
      WHERE q.id = ${queenId}

      UNION ALL

      SELECT q.*, h.position_label as hive_name, a.name as apiary_name
      FROM queens q
      LEFT JOIN hives h ON q.hive_id = h.id
      LEFT JOIN apiaries a ON h.apiary_id = a.id
      INNER JOIN lineage l ON q.id = l.parent_queen_id::uuid
    )
    SELECT * FROM lineage
  `);

  return result;
}

// Get descendants for a specific queen
export async function getQueenDescendants(queenId: string) {
  await requireSession();
  const result = await db.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT q.*, h.position_label as hive_name, a.name as apiary_name
      FROM queens q
      LEFT JOIN hives h ON q.hive_id = h.id
      LEFT JOIN apiaries a ON h.apiary_id = a.id
      WHERE q.id = ${queenId}

      UNION ALL

      SELECT q.*, h.position_label as hive_name, a.name as apiary_name
      FROM queens q
      LEFT JOIN hives h ON q.hive_id = h.id
      LEFT JOIN apiaries a ON h.apiary_id = a.id
      INNER JOIN descendants d ON q.parent_queen_id::uuid = d.id
    )
    SELECT * FROM descendants
  `);

  return result;
}

export async function deleteQueen(id: string) {
  await requireSession();
  const queen = await db.select({ hiveId: queens.hiveId }).from(queens).where(eq(queens.id, id)).limit(1);
  await db.delete(queens).where(eq(queens.id, id));
  revalidatePath("/genealogy");
  if (queen[0]?.hiveId) {
    revalidatePath(`/hives/${queen[0].hiveId}`);
  }
}
