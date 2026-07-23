import type { Metadata } from "next";

import { RecommendationsView } from "@/features/recommendations/recommendations-view";

export const metadata: Metadata = { title: "Recommendations" };

export default function RecommendationsPage() {
  return <RecommendationsView />;
}
