"use client";

import * as React from "react";
import Link from "next/link";
import { ClipboardList, Crown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useRecentInspections } from "@/features/inspections/hooks";
import { useHives, type Hive } from "@/features/hives/hooks";
import { formatDate } from "@/features/hives/lib";
import { hiveDisplayLabel } from "@/lib/hive-label";
import { WidgetFrame } from "./widget-frame";

/**
 * Labels are reused, so an inspection of the old A4 and one of the new A4
 * must not both read "A4": name each hive against its apiary's roster.
 */
function useHiveLabels(): Map<string, string> {
  const roster = useHives({ includeArchived: true });
  return React.useMemo(() => {
    const hives = roster.data ?? [];
    const byApiary = new Map<string, Hive[]>();
    for (const hive of hives) {
      byApiary.set(hive.apiaryId, [...(byApiary.get(hive.apiaryId) ?? []), hive]);
    }
    return new Map(
      hives.map((hive) => [
        hive.id,
        hiveDisplayLabel(hive, byApiary.get(hive.apiaryId) ?? []),
      ]),
    );
  }, [roster.data]);
}

export function RecentInspectionsWidget() {
  const inspections = useRecentInspections(5);
  const labels = useHiveLabels();

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
                  href={`/yard/hives/${inspection.hiveId}`}
                  className="truncate font-medium underline-offset-4 hover:underline"
                >
                  {labels.get(inspection.hiveId) ?? inspection.hiveName}
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
