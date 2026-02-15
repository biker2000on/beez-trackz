"use server";

import { db } from "@/db";
import { apiaries, hives } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { CanvasLayout } from "@/lib/canvas/types";


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

export async function createHiveFromCanvas(apiaryId: string, positionLabel: string) {
  const [hive] = await db
    .insert(hives)
    .values({ apiaryId, positionLabel, status: "active" })
    .returning();
  revalidatePath(`/apiaries/${apiaryId}`);
  return hive;
}
