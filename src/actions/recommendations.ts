"use server";

import { db } from "@/db";
import { aiRecommendations } from "@/db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// ---------------------------------------------------------------------------
// getActiveRecommendations — undismissed, ordered by priority then date
// ---------------------------------------------------------------------------

const priorityOrder = sql`
  CASE ${aiRecommendations.priority}
    WHEN 'urgent' THEN 0
    WHEN 'high'   THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low'    THEN 3
    ELSE 4
  END
`;

export async function getActiveRecommendations() {
  return db
    .select()
    .from(aiRecommendations)
    .where(eq(aiRecommendations.dismissed, false))
    .orderBy(priorityOrder, desc(aiRecommendations.createdAt));
}

// ---------------------------------------------------------------------------
// dismissRecommendation — sets dismissed = true
// ---------------------------------------------------------------------------

export async function dismissRecommendation(id: string) {
  await db
    .update(aiRecommendations)
    .set({ dismissed: true })
    .where(eq(aiRecommendations.id, id));

  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// runRecommendationCheck — manual trigger
// ---------------------------------------------------------------------------

export async function runRecommendationCheck() {
  const { runRecommendationCheck: engineCheck } = await import(
    "@/lib/recommendations/engine"
  );
  const result = await engineCheck({ enrichWithAI: false });

  revalidatePath("/dashboard");
  return result;
}

// ---------------------------------------------------------------------------
// getRecommendationCount — count of undismissed (for badge)
// ---------------------------------------------------------------------------

export async function getRecommendationCount() {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiRecommendations)
    .where(eq(aiRecommendations.dismissed, false));

  return Number(result[0]?.count ?? 0);
}
