"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  Camera,
  Crown,
  Droplets,
  HeartPulse,
  LocateFixed,
  MapPin,
  Package,
  type LucideIcon,
} from "lucide-react";

import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Skeleton } from "@/components/ui/skeleton";
import { useHiveFeedings } from "@/features/feedings/hooks";
import { useHiveInspections } from "@/features/inspections/hooks";
import { usePhotos } from "@/features/photos/hooks";
import { useHive, useHiveDeployments, useHiveQueens, useUpdateHiveGps } from "./hooks";
import {
  miteDisplay,
  useEndTreatment,
  useVarroaAnalytics,
} from "@/features/operations/hooks";
import { formatDate, todayInput } from "./lib";

/** "Mark removed" for the treatment behind a harvest lockout. */
function EndTreatmentButton({
  hiveId,
  treatmentEventId,
}: {
  hiveId: string;
  treatmentEventId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayInput());
  const endTreatment = useEndTreatment();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!date) {
      toast.error("Pick the removal date.");
      return;
    }
    try {
      await endTreatment.mutateAsync({
        id: treatmentEventId,
        hiveId,
        dateRemoved: date,
      });
      toast.success("Treatment marked removed");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not end treatment",
      );
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDate(todayInput());
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="mt-2">
          Mark removed
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <ShortcutForm onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="treatment-removed-date">Removed on</Label>
            <Input
              id="treatment-removed-date"
              type="date"
              value={date}
              max={todayInput()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={endTreatment.isPending}>
            {endTreatment.isPending ? "Saving…" : "End treatment"}
          </Button>
        </ShortcutForm>
      </PopoverContent>
    </Popover>
  );
}

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

export function HiveOverviewTab({
  hiveId,
  canEdit = false,
}: {
  hiveId: string;
  canEdit?: boolean;
}) {
  const hive = useHive(hiveId);
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

  const lockout = hive.data?.lockout;

  return (
    <div className="grid gap-4">
      {lockout?.locked && (
        <Card className="border-amber-500/40 bg-amber-500/10">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-800 dark:text-amber-200">
              Harvest lockout
            </p>
            <p className="mt-1 text-sm font-medium text-amber-950 dark:text-amber-50">
              {lockout.message}
            </p>
            {lockout.product && (
              <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">
                {lockout.product}
                {lockout.dateApplied ? ` on ${formatDate(lockout.dateApplied)}` : ""}
                {lockout.treatmentOn
                  ? " · still on"
                  : lockout.dateRemoved
                    ? ` · off ${formatDate(lockout.dateRemoved)}`
                    : ""}
              </p>
            )}
            {canEdit && lockout.treatmentOn && lockout.treatmentEventId && (
              <EndTreatmentButton
                hiveId={hiveId}
                treatmentEventId={lockout.treatmentEventId}
              />
            )}
          </CardContent>
        </Card>
      )}
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
      <HiveGpsCard hive={hive.data} canEdit={canEdit} />
    </div>
  );
}

function formatCoord(n: number): string {
  return n.toFixed(6);
}

function HiveGpsCard({
  hive,
  canEdit,
}: {
  hive: ReturnType<typeof useHive>["data"];
  canEdit: boolean;
}) {
  const updateGps = useUpdateHiveGps(hive?.id ?? "");
  const [locating, setLocating] = React.useState(false);
  if (!hive) return null;

  const hasGps =
    hive.latitude != null &&
    hive.longitude != null &&
    Number.isFinite(hive.latitude) &&
    Number.isFinite(hive.longitude);

  async function save(latitude: number | null, longitude: number | null) {
    try {
      await updateGps.mutateAsync({ latitude, longitude });
      toast.success(
        latitude == null ? "Hive GPS cleared" : "Hive GPS saved",
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not update hive GPS",
      );
    }
  }

  function recapture() {
    if (!("geolocation" in navigator)) {
      toast.error("Geolocation is not supported by this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const lat =
          Math.round(position.coords.latitude * 1e8) / 1e8;
        const lng =
          Math.round(position.coords.longitude * 1e8) / 1e8;
        void save(lat, lng);
      },
      (error) => {
        setLocating(false);
        toast.error(error.message || "Could not read this device's location");
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <MapPin className="size-3.5" />
            GPS
          </p>
          {hasGps ? (
            <p className="mt-1 font-mono text-sm tabular-nums">
              {formatCoord(hive.latitude!)}, {formatCoord(hive.longitude!)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              No coordinates stored. Recapture from this device, or place the
              hive on a mapped stand.
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            A manual capture survives yard-map layout saves, even while the
            hive sits on a mapped stand, until you clear it. Without a manual
            capture, GPS is derived from the stand slot.
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={recapture}
              disabled={updateGps.isPending || locating}
            >
              <LocateFixed className="size-4" />
              {locating ? "Locating…" : hasGps ? "Recapture" : "Capture"}
            </Button>
            {hasGps && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void save(null, null)}
                disabled={updateGps.isPending}
              >
                Clear
              </Button>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
