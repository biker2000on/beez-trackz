"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { PhotoSection } from "@/features/photos/photo-gallery";
import { ApiaryPhotoTimeline } from "@/features/photos/timeline";
import { FloraTab } from "./flora-tab";
import { useApiary } from "./hooks";

/**
 * The Flora and Photos tab bodies. The record header and the tab strip come
 * from `ApiaryRecordLayout`; this only needs the viewer's role. Photos holds
 * both the apiary's own photos and the Immich evidence (`#evidence`) that
 * used to be the Timeline tab.
 */
export function ApiarySubpage({
  apiaryId,
  section,
}: {
  apiaryId: string;
  section: "flora" | "photos";
}) {
  const apiary = useApiary(apiaryId);
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );

  if (apiary.isPending) return <Skeleton className="h-72 w-full" />;
  if (apiary.isError || !apiary.data) return null;

  if (section === "flora") return <FloraTab apiaryId={apiaryId} canEdit={canEdit} />;
  return (
    <div className="grid gap-8">
      <PhotoSection ownerType="apiary" ownerId={apiaryId} canEdit={canEdit} />
      <section id="evidence" aria-label="Immich evidence" className="scroll-mt-24">
        <ApiaryPhotoTimeline apiaryId={apiaryId} canEdit={canEdit} />
      </section>
    </div>
  );
}
