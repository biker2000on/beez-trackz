"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { PhotoSection } from "@/features/photos/photo-gallery";
import { EquipmentTab } from "./equipment-tab";
import { useHive } from "./hooks";
import { QueenTab } from "./queen-tab";

export type HiveSubsection = "equipment" | "queen" | "photos";

const SECTION_COPY: Record<HiveSubsection, { title: string; description: string }> = {
  equipment: {
    title: "Equipment",
    description: "Equipment currently deployed to this hive and its return history.",
  },
  queen: {
    title: "Queen",
    description: "The current queen, lineage, and prior queen records.",
  },
  photos: {
    title: "Photos",
    description: "The hive photo gallery and uploads.",
  },
};

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
  if (hive.isError || !hive.data) {
    return <p className="text-sm text-muted-foreground">Could not load this hive.</p>;
  }

  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, hive.data.apiaryId) ?? "",
  );
  const copy = SECTION_COPY[section];

  return (
    <div className="grid gap-5">
      <header className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-3 w-fit">
          <Link href={`/yard/hives/${hiveId}`}>
            <ArrowLeft />
            {hive.data.positionLabel}
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.description}</p>
        </div>
      </header>

      {section === "equipment" ? (
        <EquipmentTab hiveId={hiveId} canManage={access.data?.isAdmin ?? false} />
      ) : section === "queen" ? (
        <QueenTab hiveId={hiveId} canEdit={canEdit} />
      ) : (
        <PhotoSection ownerType="hive" ownerId={hiveId} canEdit={canEdit} />
      )}
    </div>
  );
}
