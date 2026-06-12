"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { apiaries, hives, hiveLocationHistory } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type {
  CanvasLayout,
  LegacyCanvasLayout,
  HivePlacement,
} from "@/lib/canvas/types";
import { getSlotLabel } from "@/lib/canvas/types";

/**
 * Persist canvas geometry (stands, north arrow, viewport). Hive↔slot
 * assignment lives on the hives table and is never written here — any
 * legacy occupancy embedded in the payload is stripped.
 */
export async function saveCanvasLayout(apiaryId: string, layout: CanvasLayout) {
  await requireSession();
  if (!apiaryId) {
    return { error: "Apiary ID is required" };
  }

  const geometryOnly: CanvasLayout = {
    stands: (layout.stands ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      x: s.x,
      y: s.y,
      rotation: s.rotation,
      rows: s.rows,
      cols: s.cols,
    })),
    northArrow: layout.northArrow,
    zoom: layout.zoom,
    offsetX: layout.offsetX,
    offsetY: layout.offsetY,
  };

  await db
    .update(apiaries)
    .set({ canvasLayout: geometryOnly, updatedAt: new Date() })
    .where(eq(apiaries.id, apiaryId));

  revalidatePath(`/apiaries/${apiaryId}`);
  return { success: true };
}

/**
 * One-time migration for legacy layouts that embedded hive occupancy in
 * the JSONB blob (stands[].slots[].hives or the flat `hives` map). Copies
 * any assignment the hives table doesn't already have into the relational
 * columns, then re-saves the blob as geometry-only.
 */
export async function normalizeCanvasLayout(apiaryId: string) {
  await requireSession();
  const [apiary] = await db
    .select()
    .from(apiaries)
    .where(eq(apiaries.id, apiaryId))
    .limit(1);
  if (!apiary?.canvasLayout) return;

  const layout = apiary.canvasLayout as LegacyCanvasLayout;
  const hasEmbeddedOccupancy = layout.stands?.some((s) => s.slots?.length);
  if (!hasEmbeddedOccupancy && !layout.hives) return;

  if (hasEmbeddedOccupancy) {
    const apiaryHives = await db
      .select({ id: hives.id, standId: hives.standId })
      .from(hives)
      .where(eq(hives.apiaryId, apiaryId));
    const unassigned = new Set(
      apiaryHives.filter((h) => h.standId == null).map((h) => h.id)
    );

    for (const stand of layout.stands ?? []) {
      for (const slot of stand.slots ?? []) {
        for (const slotHive of slot.hives) {
          if (!unassigned.has(slotHive.hiveId)) continue;
          await db
            .update(hives)
            .set({
              standId: stand.id,
              slotRow: slot.row,
              slotCol: slot.col,
              placement: (slotHive.placement as HivePlacement) ?? "full",
              facingDegrees: Math.round(slotHive.facingDegrees ?? 0),
              updatedAt: new Date(),
            })
            .where(eq(hives.id, slotHive.hiveId));
        }
      }
    }
  }

  await saveCanvasLayout(apiaryId, layout as CanvasLayout);
}

export async function createHiveFromCanvas(
  apiaryId: string,
  standId: string,
  standLabel: string,
  slotRow: number,
  slotCol: number,
  standCols: number
) {
  await requireSession();
  const positionLabel = getSlotLabel(standLabel, slotRow, slotCol, standCols);
  const [hive] = await db
    .insert(hives)
    .values({
      apiaryId,
      positionLabel,
      standId,
      slotRow,
      slotCol,
      placement: "full",
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
      placement: data.placement ? (data.placement as HivePlacement) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(hives.id, hiveId));

  revalidatePath("/hives");
  revalidatePath(`/hives/${hiveId}`);
}

/**
 * Assign a hive to a stand slot. The single write path for canvas hive
 * placement: updates the relational columns and the location history.
 */
export async function assignHiveToSlot(params: {
  hiveId: string;
  apiaryId: string;
  standId: string;
  standLabel: string;
  slotRow: number;
  slotCol: number;
  standCols: number;
  placement?: HivePlacement;
}) {
  await requireSession();
  const { hiveId, apiaryId, standId, standLabel, slotRow, slotCol, standCols } =
    params;
  const placement = params.placement ?? "full";
  const positionLabel = getSlotLabel(standLabel, slotRow, slotCol, standCols);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(hiveLocationHistory)
      .set({ dateTo: now })
      .where(
        and(eq(hiveLocationHistory.hiveId, hiveId), isNull(hiveLocationHistory.dateTo))
      );

    await tx.insert(hiveLocationHistory).values({
      hiveId,
      apiaryId,
      positionLabel,
      dateFrom: now,
    });

    await tx
      .update(hives)
      .set({
        positionLabel,
        standId,
        slotRow,
        slotCol,
        placement,
        updatedAt: now,
      })
      .where(eq(hives.id, hiveId));
  });

  revalidatePath(`/apiaries/${apiaryId}`);
  revalidatePath(`/hives/${hiveId}`);
  return { positionLabel };
}

/** Set the placement of a hive already in a slot (used when stacking). */
export async function setHivePlacement(hiveId: string, placement: HivePlacement) {
  await requireSession();
  await db
    .update(hives)
    .set({ placement, updatedAt: new Date() })
    .where(eq(hives.id, hiveId));
}

/** Remove a hive from its slot (keeps the hive, clears the assignment). */
export async function removeHiveFromSlot(hiveId: string, apiaryId: string) {
  await requireSession();
  await db
    .update(hives)
    .set({ standId: null, slotRow: null, slotCol: null, placement: "full", updatedAt: new Date() })
    .where(eq(hives.id, hiveId));
  revalidatePath(`/apiaries/${apiaryId}`);
}

/** Set the facing direction (degrees from north) for a hive. */
export async function setHiveFacing(hiveId: string, apiaryId: string, facingDegrees: number) {
  await requireSession();
  const normalized = ((Math.round(facingDegrees) % 360) + 360) % 360;
  await db
    .update(hives)
    .set({ facingDegrees: normalized, updatedAt: new Date() })
    .where(eq(hives.id, hiveId));
  revalidatePath(`/apiaries/${apiaryId}`);
}
