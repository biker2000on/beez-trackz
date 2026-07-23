"use client";

import Link from "next/link";
import { Frame } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useFrameSummary } from "./hooks";
import { WidgetFrame } from "./widget-frame";

export function FrameShortageWidget() {
  const summary = useFrameSummary();
  const standalone = summary.data?.standalone;
  const spare = standalone?.total ?? 0;

  return (
    <WidgetFrame
      title="Spare frames"
      icon={Frame}
      isLoading={summary.isPending}
      isError={summary.isError}
      action={
        <Link
          href="/inventory"
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Inventory
        </Link>
      }
    >
      <div className="grid gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">{spare}</span>
          <span className="text-sm text-muted-foreground">
            spare frames in storage
          </span>
        </div>
        {spare <= 0 ? (
          <p className="text-sm text-destructive">
            Frame shortage — no spare frames on hand.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{standalone?.drawn ?? 0} drawn</Badge>
            <Badge variant="secondary">{standalone?.fresh ?? 0} fresh</Badge>
            {(standalone?.unspecified ?? 0) > 0 && (
              <Badge variant="outline">
                {standalone?.unspecified} unspecified
              </Badge>
            )}
          </div>
        )}
      </div>
    </WidgetFrame>
  );
}
