"use client";

import Link from "next/link";
import { ClipboardList, Crown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useRecentInspections } from "@/features/inspections/hooks";
import { formatDate } from "@/features/hives/lib";
import { WidgetFrame } from "./widget-frame";

export function RecentInspectionsWidget() {
  const inspections = useRecentInspections(5);

  return (
    <WidgetFrame
      title="Recent inspections"
      icon={ClipboardList}
      isLoading={inspections.isPending}
      isError={inspections.isError}
    >
      {(inspections.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No inspections yet.</p>
      ) : (
        <ul className="grid gap-2">
          {inspections.data?.map((inspection) => (
            <li
              key={inspection.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Link
                  href={`/hives/${inspection.hiveId}`}
                  className="truncate font-medium underline-offset-4 hover:underline"
                >
                  {inspection.hiveName}
                </Link>
                {inspection.queenSeen && (
                  <Badge
                    variant="accent"
                    className="gap-1 px-1.5"
                    title="Queen seen"
                  >
                    <Crown className="size-3" />Q
                  </Badge>
                )}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDate(inspection.date)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}
