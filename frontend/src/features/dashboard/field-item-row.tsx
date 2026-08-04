"use client";

import * as React from "react";
import Link from "next/link";
import { AlarmClock, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useSetRecommendationState } from "@/features/recommendations/api";

import { FeedingQuickActions } from "./feeding-actions";
import type { FieldItem } from "./hooks";

/** Snooze/dismiss for a recommendation row, mirroring the triage page. */
function RecommendationQuickActions({ id }: { id: string }) {
  const setState = useSetRecommendationState();

  async function run(state: "dismissed" | "snoozed", success: string) {
    try {
      await setState.mutateAsync({ ids: [id], state });
      toast.success(success);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not update the recommendation",
      );
    }
  }

  return (
    <div className="flex shrink-0 gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Snooze recommendation for 7 days"
        title="Snooze 7 days (s)"
        disabled={setState.isPending}
        onClick={() => void run("snoozed", "Snoozed for 7 days")}
      >
        <AlarmClock className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss recommendation"
        title="Dismiss (d)"
        disabled={setState.isPending}
        onClick={() => void run("dismissed", "Recommendation dismissed")}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/**
 * One line of work: the action in bold, the evidence underneath, and the
 * buttons that resolve it without leaving the dashboard — refill/close for
 * feeders, snooze/dismiss for recommendations.
 */
export function FieldItemRow({
  item,
  showActions = true,
  focused = false,
}: {
  item: FieldItem;
  showActions?: boolean;
  focused?: boolean;
}) {
  const urgent = item.priority === "urgent";

  return (
    <li
      data-field-id={item.id}
      tabIndex={focused ? 0 : -1}
      className={cn(
        "-mx-2 flex items-start justify-between gap-3 rounded-md px-2 py-1 outline-none",
        focused && "ring-1 ring-primary/40 bg-primary/5",
      )}
    >
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
      {showActions &&
      item.kind === "recommendation" &&
      item.recommendationId ? (
        <RecommendationQuickActions id={item.recommendationId} />
      ) : null}
    </li>
  );
}
