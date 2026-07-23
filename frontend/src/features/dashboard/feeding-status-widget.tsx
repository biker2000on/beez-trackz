"use client";

import Link from "next/link";
import { Droplets, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  feedingTypeLabel,
  useActiveFeedings,
} from "@/features/feedings/hooks";
import { daysSince } from "@/features/hives/lib";
import { WidgetFrame } from "./widget-frame";

export function FeedingStatusWidget() {
  const feedings = useActiveFeedings();
  const list = feedings.data ?? [];

  return (
    <WidgetFrame
      title="Feeding status"
      icon={Droplets}
      isLoading={feedings.isPending}
      isError={feedings.isError}
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active feeders.</p>
      ) : (
        <ul className="grid gap-2">
          {list.map((feeding) => {
            const age = daysSince(feeding.dateFed);
            const stale = age > 7;
            return (
              <li
                key={feeding.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <div className="min-w-0">
                  <Link
                    href={`/hives/${feeding.hiveId}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {feeding.hiveName}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {feedingTypeLabel(feeding.type)} · {feeding.quantity}{" "}
                    {feeding.quantityUnit}
                  </p>
                </div>
                <Badge
                  variant={stale ? "destructive" : "secondary"}
                  className="shrink-0 gap-1"
                >
                  {stale && <TriangleAlert className="size-3" />}
                  {age}d
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetFrame>
  );
}
