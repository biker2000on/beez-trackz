"use client";

import Link from "next/link";
import { Hexagon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useApiaries } from "@/features/apiaries/hooks";
import { useHives } from "@/features/hives/hooks";
import {
  HIVE_STATUSES,
  HIVE_STATUS_BADGE,
  HIVE_STATUS_LABELS,
} from "@/features/hives/lib";
import { WidgetFrame } from "./widget-frame";

export function HiveOverviewWidget() {
  const hives = useHives();
  const apiaries = useApiaries();

  const counts = new Map<string, number>();
  for (const hive of hives.data ?? []) {
    counts.set(hive.status, (counts.get(hive.status) ?? 0) + 1);
  }

  return (
    <WidgetFrame
      title="Hive overview"
      icon={Hexagon}
      isLoading={hives.isPending || apiaries.isPending}
      isError={hives.isError || apiaries.isError}
    >
      <div className="grid gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">{hives.data?.length ?? 0}</span>
          <span className="text-sm text-muted-foreground">
            hives across {apiaries.data?.length ?? 0}{" "}
            {(apiaries.data?.length ?? 0) === 1 ? "apiary" : "apiaries"}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {HIVE_STATUSES.filter((status) => (counts.get(status) ?? 0) > 0).map(
            (status) => (
              <Badge key={status} className={HIVE_STATUS_BADGE[status]}>
                {counts.get(status)} {HIVE_STATUS_LABELS[status].toLowerCase()}
              </Badge>
            ),
          )}
          {(hives.data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              No hives yet.{" "}
              <Link
                href="/hives"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Add your first hive
              </Link>
            </p>
          )}
        </div>
      </div>
    </WidgetFrame>
  );
}
