"use client";

import { Skeleton } from "@/components/ui/skeleton";
import ApiaryCanvas from "@/features/canvas";
import { useApiaryHives } from "@/features/canvas/lib/use-canvas-data";
import { apiaryRole, useAccessProfile } from "@/features/access/api";

import { OverviewTab } from "./overview-tab";
import { useApiary } from "./hooks";
import { NoteText } from "@/components/record/source-note";

export const APIARY_TABS = ["overview", "layout"] as const;
export type ApiaryTab = (typeof APIARY_TABS)[number];

/**
 * The Overview and Map tab bodies. The record header, the action bar and the
 * tab strip belong to `ApiaryRecordLayout`; the bare record URL still opens
 * the map.
 */
export function ApiaryDetailPage({
  apiaryId,
  section = "layout",
}: {
  apiaryId: string;
  section?: ApiaryTab;
}) {
  const apiary = useApiary(apiaryId);
  const hives = useApiaryHives(apiaryId);
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );

  if (apiary.isPending) {
    return <Skeleton className="h-[430px] rounded-xl" />;
  }
  if (apiary.isError) return null;

  const detail = apiary.data;
  if (section === "overview") {
    return (
      <section className="grid gap-5">
        <NoteText
          text={detail.notes}
          className="max-w-prose text-sm text-muted-foreground"
        />
        <OverviewTab
          apiaryId={apiaryId}
          hives={hives.data ?? []}
          hivesReady={!hives.isPending}
        />
      </section>
    );
  }
  return (
    <section className="min-w-0">
      <div className="relative">
        {!canEdit ? (
          <span className="absolute right-3 top-3 z-20 rounded-full border bg-background/90 px-2 py-1 text-xs font-medium shadow-sm">
            View only
          </span>
        ) : null}
        <ApiaryCanvas apiaryId={apiaryId} />
      </div>
    </section>
  );
}
