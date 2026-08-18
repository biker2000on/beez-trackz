"use client";

import Link from "next/link";
import {
  Activity,
  Camera,
  Crown,
  Droplets,
  HeartPulse,
  Package,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHiveFeedings } from "@/features/feedings/hooks";
import { useHiveInspections } from "@/features/inspections/hooks";
import { usePhotos } from "@/features/photos/hooks";
import { useHiveDeployments, useHiveQueens } from "./hooks";
import { miteDisplay, useVarroaAnalytics } from "@/features/operations/hooks";
import { formatDate } from "./lib";

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  href,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  href: string;
  loading?: boolean;
}) {
  return (
    <Card className="transition-colors hover:border-primary/40">
      <Link href={href} className="block h-full focus-visible:outline-none">
        <CardContent className="p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Icon className="size-3.5" />
            {label}
          </p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-24" />
          ) : (
            <p className="mt-1 text-lg font-semibold">{value}</p>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </CardContent>
      </Link>
    </Card>
  );
}

export function HiveOverviewTab({ hiveId }: { hiveId: string }) {
  const inspections = useHiveInspections(hiveId);
  const varroa = useVarroaAnalytics(hiveId);
  const feedings = useHiveFeedings(hiveId);
  const deployments = useHiveDeployments(hiveId);
  const queens = useHiveQueens(hiveId);
  const photos = usePhotos("hive", hiveId);

  const latestInspection = [...(inspections.data ?? [])].sort((a, b) =>
    b.date.localeCompare(a.date),
  )[0];
  const latestFeeding = [...(feedings.data ?? [])].sort((a, b) =>
    b.dateFed.localeCompare(a.dateFed),
  )[0];
  const openFeeders = (feedings.data ?? []).filter(
    (feeding) => feeding.status === "open",
  ).length;
  const activeEquipment = (deployments.data ?? []).reduce(
    (sum, deployment) =>
      deployment.dateRemoved
        ? sum
        : sum + (deployment.outstanding ?? deployment.quantity),
    0,
  );
  const currentQueen = (queens.data ?? []).find(
    (queen) => queen.status === "active",
  );
  const latestMite = varroa.data?.latest ?? null;
  const mite = latestMite ? miteDisplay(latestMite) : null;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard
          icon={HeartPulse}
          label="Health"
          value={
            mite
              ? mite.label
              : latestInspection
                ? `Inspected ${formatDate(latestInspection.date)}`
                : "No mite count"
          }
          detail={
            mite && latestMite
              ? `${mite.unit}${varroa.data?.overThreshold ? " · over action level" : ""} · ${formatDate(latestMite.date)}`
              : "Varroa load and inspection summary"
          }
          href={`/hives/${hiveId}?tab=health`}
          loading={inspections.isPending || varroa.isPending}
        />
        <SummaryCard
          icon={Droplets}
          label="Feeding"
          value={`${openFeeders} open ${openFeeders === 1 ? "feeder" : "feeders"}`}
          detail={latestFeeding ? `Last fed ${formatDate(latestFeeding.dateFed)}` : "No feeding recorded"}
          href={`/hives/${hiveId}?tab=timeline&view=feedings`}
          loading={feedings.isPending}
        />
        <SummaryCard
          icon={Crown}
          label="Queen"
          value={currentQueen ? "Active queen" : "No active queen"}
          detail={currentQueen?.introducedDate ? `Introduced ${formatDate(currentQueen.introducedDate)}` : "Open queen history"}
          href={`/hives/${hiveId}/queen`}
          loading={queens.isPending}
        />
        <SummaryCard
          icon={Package}
          label="Equipment"
          value={`${activeEquipment} deployed`}
          detail="Current and returned equipment"
          href={`/hives/${hiveId}/equipment`}
          loading={deployments.isPending}
        />
        <SummaryCard
          icon={Camera}
          label="Photos"
          value={`${photos.data?.length ?? 0} on file`}
          detail="View and add hive photos"
          href={`/hives/${hiveId}/photos`}
          loading={photos.isPending}
        />
        <SummaryCard
          icon={Activity}
          label="Timeline"
          value="Full history"
          detail="Inspections, feedings, treatments, moves, and harvests"
          href={`/hives/${hiveId}?tab=timeline`}
        />
      </div>
    </div>
  );
}
