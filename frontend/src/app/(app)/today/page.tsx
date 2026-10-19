import { TodayView } from "@/features/work/today-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/today");

/**
 * `?view=all` is the old Recommendations page: the same `GET /work/today`,
 * narrowed to recommendations and widened to the snoozed and dismissed
 * statuses so triage history is visible.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  if (view === "all") {
    return (
      <TodayView
        description="Every recommendation and what has already been triaged. Same items, same commands as Today — only the filter differs."
        filter={{
          sourceType: ["recommendation"],
          status: ["open", "snoozed", "dismissed"],
        }}
      />
    );
  }
  return <TodayView />;
}
