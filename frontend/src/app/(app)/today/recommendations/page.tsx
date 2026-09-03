import type { Metadata } from "next";

import { TodayView } from "@/features/work/today-view";

export const metadata: Metadata = { title: "Recommendations" };

/**
 * The third filter over the one response shape (design 2026-09-03 §4.8): the
 * same `GET /work/today`, narrowed to recommendations and widened to the
 * snoozed and dismissed statuses so triage history is visible. It is not a
 * separate inbox with its own assembler — that is what is being retired.
 */
export default function TodayRecommendationsPage() {
  return (
    <TodayView
      title="Recommendations"
      description="Every recommendation and what has already been triaged. Same items, same commands as Today — only the filter differs."
      filter={{
        sourceType: ["recommendation"],
        status: ["open", "snoozed", "dismissed"],
      }}
    />
  );
}
