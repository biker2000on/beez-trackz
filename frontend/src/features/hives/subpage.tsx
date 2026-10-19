"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { PhotoSection } from "@/features/photos/photo-gallery";
import { EquipmentTab } from "./equipment-tab";
import { useHive } from "./hooks";
import { QueenTab } from "./queen-tab";

export type HiveSubsection = "equipment" | "queen" | "photos";

/**
 * The Equipment, Queen and Photos tab bodies. The record header and the tab
 * strip come from `HiveRecordLayout`; this only needs the hive for the
 * viewer's role.
 */
export function HiveSubpage({
  hiveId,
  section,
}: {
  hiveId: string;
  section: HiveSubsection;
}) {
  const hive = useHive(hiveId);
  const access = useAccessProfile();

  if (hive.isPending) return <Skeleton className="h-72 w-full" />;
  if (hive.isError || !hive.data) return null;

  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, hive.data.apiaryId) ?? "",
  );

  if (section === "equipment") {
    return (
      <EquipmentTab hiveId={hiveId} canManage={access.data?.isAdmin ?? false} />
    );
  }
  if (section === "queen") return <QueenTab hiveId={hiveId} canEdit={canEdit} />;
  return <PhotoSection ownerType="hive" ownerId={hiveId} canEdit={canEdit} />;
}
