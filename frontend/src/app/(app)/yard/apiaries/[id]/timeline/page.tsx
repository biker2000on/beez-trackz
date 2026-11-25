import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiaryTimeline } from "@/features/apiaries/timeline-page";

/**
 * The apiary Timeline: visit days from `GET /apiaries/{id}/activity`. The
 * Immich photo evidence that used to live here is on the Photos tab
 * (`/yard/apiaries/{id}/photos#evidence`); this URL did not change.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    // `useSearchParams` (filters, `?date=`) needs a Suspense boundary.
    <Suspense fallback={<Skeleton className="h-80 w-full" />}>
      <ApiaryTimeline apiaryId={id} />
    </Suspense>
  );
}
