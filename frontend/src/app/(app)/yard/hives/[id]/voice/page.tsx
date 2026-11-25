import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { VisitWorkspace } from "@/features/transcription/visit-workspace";

/**
 * Voice inspection for one hive, inside the hive record: the record layout
 * keeps the hive's header and tabs, and the workspace is locked to this hive.
 */
export default async function HiveVoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <VisitWorkspace hiveId={id} />
    </Suspense>
  );
}
