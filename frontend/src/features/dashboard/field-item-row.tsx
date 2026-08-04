"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { FeedingQuickActions } from "./feeding-actions";
import type { FieldItem } from "./hooks";

/**
 * One line of work: the action in bold, the evidence underneath, and — when
 * the item is a feeder — the buttons that resolve it without leaving the
 * dashboard.
 */
export function FieldItemRow({
  item,
  showActions = true,
}: {
  item: FieldItem;
  showActions?: boolean;
}) {
  const urgent = item.priority === "urgent";

  return (
    <li className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              urgent ? "bg-destructive" : "bg-primary",
            )}
          />
          {item.action || "Review"}
          {item.hiveId ? (
            <Link
              href={`/hives/${item.hiveId}`}
              className="truncate text-muted-foreground underline-offset-4 hover:underline"
            >
              {item.hiveName ?? "hive"}
            </Link>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{item.evidence}</p>
      </div>
      {showActions && item.kind === "feeding" && item.feedingId ? (
        <FeedingQuickActions
          feedingId={item.feedingId}
          hiveName={item.hiveName}
          unverified={item.unverified}
        />
      ) : null}
    </li>
  );
}
