"use client";

import * as React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Crown } from "lucide-react";

import { cn } from "@/lib/utils";
import { QUEEN_ORIGIN_LABELS, type QueenStatus } from "./api";
import { markingColorForDate } from "./marking";
import type { QueenFlowNode } from "./layout";

const STATUS_CLASSES: Record<QueenStatus, string> = {
  active: "bg-accent-muted text-accent dark:bg-accent dark:text-accent-foreground",
  superseded: "bg-secondary text-secondary-foreground",
  dead: "bg-destructive/15 text-destructive",
  missing: "bg-warning/20 text-foreground",
};

const STATUS_LABELS: Record<QueenStatus, string> = {
  active: "Active",
  superseded: "Superseded",
  dead: "Dead",
  missing: "Missing",
};

/** Marking-year color dot; falls back to a hollow dot when no date is set. */
export function MarkingDot({
  date,
  className,
}: {
  date: string | null;
  className?: string;
}) {
  const marking = markingColorForDate(date);
  if (!marking) {
    return (
      <span
        className={cn(
          "inline-block size-3 shrink-0 rounded-full border-2 border-muted-foreground/50",
          className,
        )}
        title="No introduction date"
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-block size-3 shrink-0 rounded-full",
        marking.needsBorder && "border border-stone-400",
        className,
      )}
      style={{ backgroundColor: marking.color }}
      title={`${marking.year} — ${marking.name}`}
    />
  );
}

export const QueenNode = React.memo(function QueenNode({
  data,
  selected,
}: NodeProps<QueenFlowNode>) {
  const { queen } = data;
  const marking = markingColorForDate(queen.introducedDate);

  return (
    <div
      className={cn(
        "w-48 rounded-lg border bg-card px-3 py-2 text-left shadow-sm transition-shadow",
        selected ? "border-ring ring-2 ring-ring" : "hover:shadow-md",
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!size-2 !border-none !bg-muted-foreground/60"
      />
      <div className="flex items-center gap-1.5">
        <MarkingDot date={queen.introducedDate} />
        <span className="flex items-center gap-1 truncate text-sm font-semibold">
          <Crown className="size-3.5 shrink-0 text-primary" />
          {marking ? `${marking.year} queen` : "Queen"}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {queen.hiveName
          ? `${queen.apiaryName ?? "?"} — ${queen.hiveName}`
          : "Not in a hive"}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
            STATUS_CLASSES[queen.status] ?? STATUS_CLASSES.active,
          )}
        >
          {STATUS_LABELS[queen.status] ?? queen.status}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {QUEEN_ORIGIN_LABELS[queen.origin] ?? queen.origin}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!size-2 !border-none !bg-muted-foreground/60"
      />
    </div>
  );
});
