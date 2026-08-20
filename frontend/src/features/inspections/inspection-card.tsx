"use client";

import * as React from "react";
import { CloudSun, Crown, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/features/hives/lib";
import { usePhotos } from "@/features/photos/hooks";
import { useDeleteInspection, type Inspection } from "./hooks";
import { InspectionFormDialog } from "./inspection-form-dialog";

function Rating({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  return (
    <Badge variant="secondary">
      {label} {value}/5
    </Badge>
  );
}

export function InspectionCard({
  inspection,
  canEdit = true,
}: {
  inspection: Inspection;
  canEdit?: boolean;
}) {
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const deleteInspection = useDeleteInspection();
  const photos = usePhotos("inspection", inspection.id);

  async function onDelete() {
    try {
      await deleteInspection.mutateAsync(inspection.id);
      toast.success("Inspection deleted");
      setDeleteOpen(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not delete the inspection",
      );
    }
  }

  const pests = inspection.pests ?? [];
  const treatments = inspection.treatments ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {formatDate(inspection.date)}
          {inspection.queenSeen && (
            <Badge variant="accent" className="gap-1" title="Queen seen">
              <Crown className="size-3" />
              Queen seen
            </Badge>
          )}
        </CardTitle>
        {canEdit ? <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit inspection"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete inspection"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div> : null}
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {inspection.inspectorName && (
          <p className="text-muted-foreground">
            Inspected by {inspection.inspectorName}
          </p>
        )}
        {inspection.weather?.current ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <CloudSun className="size-3.5" />
              {Math.round(inspection.weather.current.temperature_2m)}°F
            </span>
            <span>
              Feels {Math.round(inspection.weather.current.apparent_temperature)}
              °F
            </span>
            <span>{inspection.weather.current.relative_humidity_2m}% humidity</span>
            <span>
              {Math.round(inspection.weather.current.wind_speed_10m)} mph wind
            </span>
          </div>
        ) : null}
        {inspection.queenHealth && <p>Queen: {inspection.queenHealth}</p>}
        {inspection.broodPattern && <p>Brood: {inspection.broodPattern}</p>}
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          <Rating label="Honey" value={inspection.storesHoney} />
          <Rating label="Pollen" value={inspection.storesPollen} />
          <Rating label="Temperament" value={inspection.temperament} />
        </div>
        {(inspection.framesOfBees != null ||
          inspection.framesOfBrood != null ||
          inspection.framesOfStores != null) && (
          <p className="text-xs text-muted-foreground">
            Strength: {inspection.framesOfBees ?? "—"} frames bees ·{" "}
            {inspection.framesOfBrood ?? "—"} brood ·{" "}
            {inspection.framesOfStores ?? "—"} stores
          </p>
        )}
        {pests.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Pests:</span>
            {pests.map((pest, i) => (
              <Badge key={i} variant="destructive">
                {pest.type}
                {pest.count != null && ` ×${pest.count}`}
              </Badge>
            ))}
          </div>
        )}
        {treatments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Treatments:</span>
            {treatments.map((treatment, i) => (
              <Badge key={i} variant="outline">
                {treatment.product}
                {treatment.method && ` (${treatment.method})`}
              </Badge>
            ))}
          </div>
        )}
        {(inspection.miteCounts ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Mites:</span>
            {(inspection.miteCounts ?? []).map((count) => {
              const rate =
                count.mitesPer100 != null
                  ? `${count.mitesPer100.toFixed(1)} / 100`
                  : count.mitesPerDay != null
                    ? `${count.mitesPerDay.toFixed(1)} / day`
                    : `${count.mitesCount} mites`;
              return (
                <Badge key={count.id} variant="secondary" className="tabular-nums">
                  {rate}
                </Badge>
              );
            })}
          </div>
        )}
        {inspection.notes && (
          <p className="whitespace-pre-wrap text-muted-foreground">
            {inspection.notes}
          </p>
        )}
        {(photos.data?.length ?? 0) > 0 && (
          <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
            {photos.data?.map((photo) => (
              // Media URLs are served by the authenticated Go API.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={photo.id}
                src={photo.mediumUrl ?? photo.thumbnailUrl ?? photo.originalUrl ?? ""}
                alt={photo.caption ?? "Inspection photo"}
                className="aspect-[4/3] w-full rounded-md border object-cover"
                loading="lazy"
              />
            ))}
          </div>
        )}
      </CardContent>

      {canEdit ? <InspectionFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        hiveId={inspection.hiveId}
        inspection={inspection}
      /> : null}
      {canEdit ? <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this inspection?</AlertDialogTitle>
            <AlertDialogDescription>
              The inspection from {formatDate(inspection.date)} will be
              permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void onDelete();
              }}
              disabled={deleteInspection.isPending}
            >
              {deleteInspection.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog> : null}
    </Card>
  );
}
