"use client";

import Link from "next/link";
import { Archive, Hexagon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Hive } from "./hooks";
import {
  HIVE_STATUS_BADGE,
  HIVE_STATUS_LABELS,
  formatDate,
  type HiveStatus,
} from "./lib";

export function HiveStatusBadge({ status }: { status: string }) {
  const known = status as HiveStatus;
  return (
    <Badge
      variant="outline"
      className={HIVE_STATUS_BADGE[known] ?? undefined}
    >
      {HIVE_STATUS_LABELS[known] ?? status}
    </Badge>
  );
}

export function HiveCard({
  hive,
  showApiary = true,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  hive: Hive;
  showApiary?: boolean;
  /** Bulk-select mode: clicking toggles selection instead of navigating. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const body = (
    <Card
      className={cn(
        "h-full transition-colors",
        selectable
          ? "cursor-pointer select-none"
          : "hover:border-primary/50",
        selected && "border-primary ring-1 ring-primary",
        hive.isArchived && "opacity-70",
      )}
    >
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {selectable && (
            <span
              aria-hidden
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-[4px] border border-input shadow-sm",
                selected && "border-primary bg-primary",
              )}
            />
          )}
          <Hexagon className="size-4 text-primary" />
          {hive.positionLabel}
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {hive.isArchived && (
            <Badge variant="outline" className="gap-1">
              <Archive className="size-3" />
              Archived
            </Badge>
          )}
          <HiveStatusBadge status={hive.status} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-0.5 text-sm text-muted-foreground">
        {showApiary && <p>{hive.apiaryName}</p>}
        {hive.lockout?.locked && (
          <p className="text-amber-700 dark:text-amber-400">
            {hive.lockout.message}
          </p>
        )}
        {hive.installedDate && (
          <p>Installed {formatDate(hive.installedDate)}</p>
        )}
      </CardContent>
    </Card>
  );

  if (selectable) {
    return (
      <button
        type="button"
        className="block w-full text-left"
        aria-pressed={selected}
        onClick={() => onToggleSelect?.(hive.id)}
      >
        {body}
      </button>
    );
  }
  return <Link href={`/yard/hives/${hive.id}`}>{body}</Link>;
}
