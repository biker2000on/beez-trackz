"use client";

import {
  Activity,
  Crown,
  Droplets,
  FlaskConical,
  MapPin,
  Scissors,
  Sprout,
  Stethoscope,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/features/hives/lib";
import { useHiveTimeline, type HiveTimelineEntry } from "./hooks";

const ICONS = {
  inspection: Stethoscope,
  feeding: Droplets,
  treatment: FlaskConical,
  mite_count: Activity,
  queen_event: Crown,
  harvest: Sprout,
  split: Scissors,
  move: MapPin,
} satisfies Record<HiveTimelineEntry["type"], typeof Activity>;

export function HiveTimeline({
  hiveId,
  types,
}: {
  hiveId: string;
  /** Restrict the timeline to these entry types (the filter chips). */
  types?: readonly HiveTimelineEntry["type"][];
}) {
  const timeline = useHiveTimeline(hiveId);
  if (timeline.isPending) return <Skeleton className="h-64 w-full" />;
  if (timeline.isError) {
    return <p className="text-sm text-muted-foreground">Could not load hive history.</p>;
  }
  const entries =
    types == null
      ? timeline.data
      : timeline.data.filter((entry) => types.includes(entry.type));
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {timeline.data.length === 0
          ? "No hive activity recorded yet."
          : "Nothing on the timeline matches this filter."}
      </p>
    );
  }
  return (
    <ol className="relative grid gap-4 border-l pl-5">
      {entries.map((entry) => {
        const Icon = ICONS[entry.type];
        return (
          <li key={`${entry.type}-${entry.id}`} className="relative">
            <span className="absolute -left-[30px] top-4 grid size-5 place-items-center rounded-full border bg-background">
              <Icon className="size-3 text-primary" />
            </span>
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-2">
                <CardTitle className="text-sm">{entry.title}</CardTitle>
                <Badge variant="outline">{formatDate(entry.date)}</Badge>
              </CardHeader>
              <CardContent className="grid gap-3">
                {entry.details && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {entry.details}
                  </p>
                )}
                {entry.photos.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {entry.photos.map((photo) => (
                      // The API serves authenticated media from a stable same-origin URL.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={photo.id}
                        src={photo.url}
                        alt={photo.caption ?? `${entry.title} photo`}
                        className="aspect-[4/3] w-full rounded-md border object-cover"
                        loading="lazy"
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
