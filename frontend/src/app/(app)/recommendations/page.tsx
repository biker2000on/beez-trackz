import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { RecommendationsView } from "@/features/recommendations/recommendations-view";

export const metadata: Metadata = { title: "Recommendations" };

export default function RecommendationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <RecommendationsView />
    </Suspense>
  );
}
