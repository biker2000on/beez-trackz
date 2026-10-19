"use client";

/**
 * Bulk recording for one yard (/yard/apiaries/[id]/bulk): the same inspection
 * or feeding across several hives at once. A tab of the apiary record with
 * its own URL, so it can be linked, resumed, and left without losing the
 * apiary page's state.
 */

import { Skeleton } from "@/components/ui/skeleton";

import { BulkActionsTab } from "./bulk-actions-tab";
import { useApiary } from "./hooks";

export function BulkRecordPage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);

  return (
    <div className="grid w-full max-w-4xl gap-5">
      <p className="max-w-prose text-sm text-muted-foreground">
        Record the same inspection or feeding across several hives in
        {apiary.data ? ` ${apiary.data.name}` : " this yard"} at once.
      </p>
      {apiary.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <BulkActionsTab apiaryId={apiaryId} />
      )}
    </div>
  );
}
