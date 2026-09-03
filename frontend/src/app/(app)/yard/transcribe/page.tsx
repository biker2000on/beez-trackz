import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { TranscribeRouteView } from "@/features/transcription/transcribe-route";

export const metadata: Metadata = { title: "Voice recording" };

export default function TranscribeRoute() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TranscribeRouteView />
    </Suspense>
  );
}
