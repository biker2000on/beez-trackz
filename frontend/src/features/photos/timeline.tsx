"use client";

import * as React from "react";
import { CalendarRange, ImageOff, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { ApiError } from "@/lib/api";
import { useApiaryPhotoTimeline, useScanApiaryPhotos } from "./hooks";
import { TimelineReviewTray } from "./review-tray";

function photoDate(value: string | null) {
  if (!value) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function ApiaryPhotoTimeline({
  apiaryId,
  canEdit,
}: {
  apiaryId: string;
  canEdit: boolean;
}) {
  const timeline = useApiaryPhotoTimeline(apiaryId);
  const scan = useScanApiaryPhotos(apiaryId);
  const [selectedYear, setSelectedYear] = React.useState<number | null>(null);

  const years = React.useMemo(
    () =>
      Array.from(
        new Set(
          (timeline.data?.photos ?? [])
            .map((photo) =>
              photo.takenDate ? new Date(photo.takenDate).getFullYear() : null,
            )
            .filter((year): year is number => year !== null),
        ),
      ).sort((a, b) => a - b),
    [timeline.data?.photos],
  );
  const effectiveYear =
    selectedYear !== null && years.includes(selectedYear)
      ? selectedYear
      : years.at(-1) ?? null;
  const visiblePhotos = (timeline.data?.photos ?? []).filter(
    (photo) =>
      effectiveYear === null ||
      (photo.takenDate && new Date(photo.takenDate).getFullYear() === effectiveYear),
  );
  const latestScan = timeline.data?.latestScan;
  const scanning = latestScan?.status === "queued" || latestScan?.status === "running";

  async function startScan() {
    try {
      const result = await scan.mutateAsync();
      toast.success(result.alreadyActive ? "Immich scan is already running" : "Immich scan queued");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not start Immich scan");
    }
  }

  if (timeline.isPending) {
    return <Skeleton className="h-80 w-full" />;
  }
  if (timeline.isError || !timeline.data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-5">
          <p className="text-sm text-muted-foreground">Could not load the yard timeline.</p>
          <Button variant="outline" size="sm" onClick={() => void timeline.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1.5">
            <CardTitle className="flex items-center gap-2">
              <CalendarRange className="size-5" />
              Yard evidence timeline
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Immich flower, bloom, bee, and hive matches near this yard, ordered by when they were taken.
            </p>
          </div>
          {canEdit ? (
            <Button
              type="button"
              variant="outline"
              disabled={scan.isPending || scanning}
              onClick={() => void startScan()}
            >
              <RefreshCw className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning…" : "Scan Immich"}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4">
          {latestScan?.status === "failed" ? (
            <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">The latest Immich scan failed.</p>
                <p>{latestScan.error ?? "Immich did not complete the search."}</p>
                <p className="mt-1 text-foreground/70">
                  Previously adopted thumbnails remain available below.
                </p>
              </div>
            </div>
          ) : null}

          {years.length > 0 ? (
            <div className="grid gap-2 rounded-lg bg-muted/50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Season</span>
                <span className="font-semibold tabular-nums">{effectiveYear}</span>
              </div>
              <Slider
                aria-label="Timeline year"
                min={0}
                max={Math.max(years.length - 1, 0)}
                step={1}
                value={[Math.max(years.indexOf(effectiveYear ?? years[0]), 0)]}
                disabled={years.length < 2}
                onValueChange={([index]) => setSelectedYear(years[index] ?? years[0])}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{years[0]}</span>
                <span>{years.at(-1)}</span>
              </div>
            </div>
          ) : null}

          {visiblePhotos.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-lg border border-dashed p-8 text-center">
              <ImageOff className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {years.length === 0
                  ? "No adopted Immich timeline photos yet."
                  : `No adopted photos from ${effectiveYear}.`}
              </p>
            </div>
          ) : (
            <div className="-mx-5 flex snap-x gap-3 overflow-x-auto px-5 pb-2">
              {visiblePhotos.map((photo) => (
                <article key={photo.id} className="w-56 shrink-0 snap-start overflow-hidden rounded-lg border">
                  <div className="aspect-[4/3] bg-muted">
                    {photo.thumbnailUrl ?? photo.mediumUrl ? (
                      // Renditions are Beez-owned and remain usable while Immich is down.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photo.thumbnailUrl ?? photo.mediumUrl ?? ""}
                        alt={photo.caption ?? "Yard timeline photo"}
                        className="size-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="grid size-full place-items-center">
                        <ImageOff className="size-5 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="grid gap-2 p-3">
                    <p className="text-sm font-semibold">{photoDate(photo.takenDate)}</p>
                    {photo.caption ? <p className="truncate text-xs text-muted-foreground">{photo.caption}</p> : null}
                    <div className="flex flex-wrap gap-1">
                      {photo.matchedTerms.map((term) => (
                        <Badge key={term} variant="secondary">{term}</Badge>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {latestScan?.status === "succeeded" ? (
            <p className="text-xs text-muted-foreground">
              Latest scan: {latestScan.matchedCount} matches, {latestScan.adoptedCount} adopted, {latestScan.reviewCount} awaiting review.
            </p>
          ) : null}
        </CardContent>
      </Card>
      {canEdit ? (
        <TimelineReviewTray apiaryId={apiaryId} candidates={timeline.data.review} />
      ) : null}
    </div>
  );
}
