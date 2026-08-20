"use client";

import { Snowflake } from "lucide-react";

import { cn } from "@/lib/utils";
import { useUnits } from "@/lib/use-units";

import type { FrostSummary } from "./hooks";

function shortDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * "This stand frosted three nights last week" — read out of the weather
 * snapshot already cached for the pin, no new provider. Lives next to
 * elevation because the two together are why two yards 400 m apart behave
 * differently.
 */
export function FrostLine({
  frost,
  className,
}: {
  frost: FrostSummary | undefined;
  className?: string;
}) {
  const units = useUnits();
  if (!frost?.available) return null;
  const lowest = units.formatTemperature(frost.lowestF);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        frost.nightsLastWeek > 0 && "text-sky-700 dark:text-sky-300",
        className,
      )}
    >
      <Snowflake className="size-4" />
      {frost.summary}
      {lowest ? ` Low ${lowest}.` : ""}
    </span>
  );
}

/**
 * The fuller read for the forecast surface: the past week, the hard freezes
 * inside it, and the next frost still in the outlook.
 */
export function FrostPanel({ frost }: { frost: FrostSummary | undefined }) {
  const units = useUnits();
  if (!frost) return null;

  if (!frost.available) {
    return (
      <p className="text-sm text-muted-foreground">
        {frost.summary} It fills in the next time the forecast is refreshed.
      </p>
    );
  }

  const threshold = units.formatTemperature(frost.thresholdF);
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center">
        <div>
          <p className="text-xl font-semibold tabular-nums">
            {frost.nightsLastWeek}
          </p>
          <p className="text-xs text-muted-foreground">
            {frost.nightsLastWeek === 1 ? "frost night" : "frost nights"}
          </p>
        </div>
        <div>
          <p className="text-xl font-semibold tabular-nums">
            {frost.hardFreezeNights}
          </p>
          <p className="text-xs text-muted-foreground">hard freezes</p>
        </div>
        <div>
          <p className="text-xl font-semibold tabular-nums">
            {units.formatTemperature(frost.lowestF) || "—"}
          </p>
          <p className="text-xs text-muted-foreground">lowest night</p>
        </div>
      </div>
      <p className="text-sm">{frost.summary}</p>
      <p className="text-xs text-muted-foreground">
        {shortDate(frost.windowStart)}–{shortDate(frost.windowEnd)} at this
        pin{threshold ? `, counting nights at or below ${threshold}` : ""}.
        {frost.dates.length
          ? ` Frosted ${frost.dates.map(shortDate).join(", ")}.`
          : ""}
      </p>
      {frost.nextFrostDate ? (
        <p className="text-sm text-sky-700 dark:text-sky-300">
          Next frost in the outlook: {shortDate(frost.nextFrostDate)}
          {frost.upcomingNights > 1
            ? ` (${frost.upcomingNights} nights ahead)`
            : ""}
          .
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No frost in the 10-day outlook.
        </p>
      )}
    </div>
  );
}
