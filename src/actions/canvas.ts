"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { apiaries, hives, hiveLocationHistory } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { CanvasLayout } from "@/lib/canvas/types";


export async function saveCanvasLayout(apiaryId: string, layout: CanvasLayout) {
  await requireSession();
  if (!apiaryId) {
    return { error: "Apiary ID is required" };
  }

  await db
    .update(apiaries)
    .set({
      canvasLayout: layout,
      updatedAt: new Date(),
    })
    .where(eq(apiaries.id, apiaryId));

  revalidatePath(`/apiaries/${apiaryId}`);
  return { success: true };
}

export async function createHiveFromCanvas(
  apiaryId: string,
  positionLabel: string,
  standId?: string,
  slotRow?: number,
  slotCol?: number,
  placement?: string
) {
  await requireSession();
  const [hive] = await db
    .insert(hives)
    .values({
      apiaryId,
      positionLabel,
      standId: standId || null,
      slotRow: slotRow ?? null,
      slotCol: slotCol ?? null,
      placement: (placement as "full" | "top" | "bottom" | "left" | "right") || "full",
      status: "active",
    })
    .returning();
  revalidatePath(`/apiaries/${apiaryId}`);
  return hive;
}

export async function updateHiveFromCanvas(
  hiveId: string,
  data: {
    positionLabel: string;
    status: string;
    notes: string;
    placement?: string;
  }
) {
  await requireSession();
  await db
    .update(hives)
    .set({
      positionLabel: data.positionLabel.trim(),
      status: data.status as "active" | "dead" | "sold" | "combined",
      notes: data.notes.trim() || null,
      placement: data.placement
        ? (data.placement as "full" | "top" | "bottom" | "left" | "right")
        : undefined,
      updatedAt: new Date(),
    })
    .where(eq(hives.id, hiveId));

  revalidatePath("/hives");
  revalidatePath(`/hives/${hiveId}`);
}

export async function moveHiveOnCanvas(
  hiveId: string,
  apiaryId: string,
  newPositionLabel: string,
  standId?: string,
  slotRow?: number,
  slotCol?: number,
  placement?: string
) {
  await requireSession();
  const now = new Date();

  await db.transaction(async (tx) => {
    // Close current location record (if any)
    await tx
      .update(hiveLocationHistory)
      .set({ dateTo: now })
      .where(
        and(
          eq(hiveLocationHistory.hiveId, hiveId),
          isNull(hiveLocationHistory.dateTo)
        )
      );

    // Open new location record
    await tx.insert(hiveLocationHistory).values({
      hiveId,
      apiaryId,
      positionLabel: newPositionLabel,
      dateFrom: now,
    });

    // Update hive record
    await tx
      .update(hives)
      .set({
        positionLabel: newPositionLabel,
        standId: standId || null,
        slotRow: slotRow ?? null,
        slotCol: slotCol ?? null,
        placement: (placement as "full" | "top" | "bottom" | "left" | "right") || "full",
        updatedAt: now,
      })
      .where(eq(hives.id, hiveId));
  });

  revalidatePath(`/apiaries/${apiaryId}`);
  revalidatePath(`/hives/${hiveId}`);
}
