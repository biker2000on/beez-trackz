import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { VisitWorkspace } from "@/features/transcription/visit-workspace";

export default async function VisitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <VisitWorkspace apiaryId={id} />
    </Suspense>
  );
}
