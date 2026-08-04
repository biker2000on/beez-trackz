import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { BatchTranscribePage } from "@/features/transcription/batch-transcribe-page";

export const metadata: Metadata = { title: "Batch transcription" };

export default function TranscribeRoute() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <BatchTranscribePage />
    </Suspense>
  );
}
