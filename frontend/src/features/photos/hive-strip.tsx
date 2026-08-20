"use client";

import * as React from "react";
import { Camera, ImageOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useHivePhotoStrip, useUpdatePhoto, type Photo } from "./hooks";

function stripDate(value: string | null) {
  if (!value) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(
    new Date(value),
  );
}

function AngleAssignment({ hiveId, photo }: { hiveId: string; photo: Photo }) {
  const update = useUpdatePhoto("hive", hiveId);
  const [angle, setAngle] = React.useState(photo.comparisonAngle ?? "");

  async function save() {
    try {
      await update.mutateAsync({ id: photo.id, comparisonAngle: angle.trim() });
      toast.success(angle.trim() ? "Photo angle saved" : "Photo removed from strip");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not save photo angle");
    }
  }

  return (
    <div className="grid gap-2">
      <Input
        value={angle}
        maxLength={80}
        placeholder="e.g. Front entrance"
        aria-label="Comparison angle"
        onChange={(event) => setAngle(event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        className="justify-self-start"
        disabled={update.isPending}
        onClick={() => void save()}
      >
        Save
      </Button>
    </div>
  );
}

export function HivePhotoStrip({ hiveId, canEdit }: { hiveId: string; canEdit: boolean }) {
  const photos = useHivePhotoStrip(hiveId);

  if (photos.isPending) return <Skeleton className="h-48 w-full" />;
  if (photos.isError) {
    return (
      <Card>
        <CardContent className="pt-5 text-sm text-muted-foreground">
          Could not load the hive photo series.
        </CardContent>
      </Card>
    );
  }

  const groups = new Map<string, Photo[]>();
  const unassigned: Photo[] = [];
  for (const photo of photos.data) {
    if (!photo.comparisonAngle) {
      unassigned.push(photo);
      continue;
    }
    const group = groups.get(photo.comparisonAngle) ?? [];
    group.push(photo);
    groups.set(photo.comparisonAngle, group);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="size-5" />
          Photo time-series
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Compare this hive from the same angle across the season. Dates come from when each photo was taken, not uploaded.
        </p>
      </CardHeader>
      <CardContent className="grid gap-5">
        {groups.size === 0 ? (
          <div className="grid place-items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <ImageOff className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Label photos with a repeatable angle to build a comparison strip.
            </p>
          </div>
        ) : (
          Array.from(groups.entries()).map(([angle, group]) => (
            <section key={angle} className="grid gap-2">
              <h3 className="text-sm font-semibold">{angle}</h3>
              <div className="-mx-5 flex snap-x gap-3 overflow-x-auto px-5 pb-2">
                {group.map((photo) => (
                  <article key={photo.id} className="w-40 shrink-0 snap-start overflow-hidden rounded-lg border">
                    <div className="aspect-square bg-muted">
                      {photo.thumbnailUrl ?? photo.mediumUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photo.thumbnailUrl ?? photo.mediumUrl ?? ""}
                          alt={photo.caption ?? `${angle} comparison`}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="grid size-full place-items-center">
                          <ImageOff className="size-5 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <p className="p-2 text-center text-xs font-medium">{stripDate(photo.takenDate)}</p>
                    {canEdit ? (
                      <div className="px-2 pb-2">
                        <AngleAssignment hiveId={hiveId} photo={photo} />
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))
        )}

        {canEdit && unassigned.length > 0 ? (
          <section className="grid gap-3 border-t pt-4">
            <div>
              <h3 className="text-sm font-semibold">Photos to label</h3>
              <p className="text-xs text-muted-foreground">
                Use the same label for shots taken from the same position.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {unassigned.map((photo) => (
                <div key={photo.id} className="grid grid-cols-[5rem_1fr] gap-3 rounded-lg border p-2">
                  {photo.thumbnailUrl ?? photo.mediumUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photo.thumbnailUrl ?? photo.mediumUrl ?? ""}
                      alt={photo.caption ?? "Unlabelled hive photo"}
                      className="size-20 rounded-md object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="grid size-20 place-items-center rounded-md bg-muted">
                      <ImageOff className="size-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="grid content-start gap-2">
                    <p className="text-xs text-muted-foreground">{stripDate(photo.takenDate)}</p>
                    <AngleAssignment hiveId={hiveId} photo={photo} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
