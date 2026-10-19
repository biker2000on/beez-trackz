"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { useApiary } from "@/features/apiaries/hooks";
import { ApiaryPhotoTimeline } from "./timeline";

/** The Timeline tab body: the record header comes from `ApiaryRecordLayout`. */
export function ApiaryTimelinePage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(apiaryRole(access.data, apiaryId) ?? "");

  if (apiary.isPending) return <Skeleton className="h-80 w-full" />;
  if (apiary.isError || !apiary.data) return null;

  return (
    <div className="grid gap-5">
      <p className="max-w-prose text-sm text-muted-foreground">
        Seasonal flora and hive-front evidence discovered in Immich near this apiary.
      </p>
      <ApiaryPhotoTimeline apiaryId={apiaryId} canEdit={canEdit} />
    </div>
  );
}
