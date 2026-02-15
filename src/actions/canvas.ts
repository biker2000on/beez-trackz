"use server";

import { db } from "@/db";
import { apiaries } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export interface CanvasLayout {
  hives: Record<string, { x: number; y: number }>;
  northArrow?: { x: number; y: number; rotation: number };
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

export async function saveCanvasLayout(apiaryId: string, layout: CanvasLayout) {
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
