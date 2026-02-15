import { getActiveRecommendations } from "@/actions/recommendations";
import { RecommendationList } from "@/components/recommendations/recommendation-list";
import { db } from "@/db";
import { hives } from "@/db/schema";
import { inArray } from "drizzle-orm";

export default async function RecommendationsPage() {
  const recommendations = await getActiveRecommendations();

  // Get hive names for recommendations that have hiveId
  const hiveIds = recommendations
    .map((r) => r.hiveId)
    .filter((id): id is string => id !== null);

  const hiveData =
    hiveIds.length > 0
      ? await db
          .select({ id: hives.id, positionLabel: hives.positionLabel })
          .from(hives)
          .where(inArray(hives.id, hiveIds))
      : [];

  const hiveNames = Object.fromEntries(
    hiveData.map((h) => [h.id, h.positionLabel])
  );

  return (
    <div className="container max-w-4xl mx-auto py-6 px-4">
      <RecommendationList
        recommendations={recommendations}
        hiveNames={hiveNames}
      />
    </div>
  );
}
