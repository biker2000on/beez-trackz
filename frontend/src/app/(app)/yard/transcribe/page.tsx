import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { TranscribeRouteView } from "@/features/transcription/transcribe-route";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/yard/transcribe");

export default function TranscribeRoute() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TranscribeRouteView />
    </Suspense>
  );
}
