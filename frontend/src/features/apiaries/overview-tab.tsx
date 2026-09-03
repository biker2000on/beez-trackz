"use client";

/**
 * Apiary overview: the default landing view for a yard. Summarizes hive
 * status, feeder state, and active blooms as cards, then shows current
 * conditions and the week's forecast (which is itself summary content).
 * Deeper work lives in the Layout peer view and dedicated drill-down routes.
 */

import Link from "next/link";
import { Camera, Droplets, Flower2, Hexagon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CanvasHive } from "@/features/canvas/lib/types";

import { ForecastTab } from "./forecast-tab";
import { useApiaryWeather, useBlooms } from "./hooks";

const HIVE_STATUS_LABELS: Record<string, string> = {
  active: "active",
  dead: "deadout",
  sold: "sold",
  archived: "archived",
};

function statusBreakdown(hives: CanvasHive[]): string {
  const counts = new Map<string, number>();
  for (const hive of hives) {
    counts.set(hive.status, (counts.get(hive.status) ?? 0) + 1);
  }
  if (counts.size <= 1) return "";
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count} ${HIVE_STATUS_LABELS[status] ?? status}`)
    .join(" · ");
}

function OverviewStat({
  icon: Icon,
  label,
  value,
  sub,
  href,
  attention,
}: {
  icon: typeof Hexagon;
  label: string;
  value: string;
  sub: string;
  href: string;
  attention?: boolean;
}) {
  return (
    <Card className="transition-colors hover:border-primary/40">
      <Link href={href} className="block focus-visible:outline-none">
        <CardContent className="p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Icon className="size-3.5" />
            {label}
          </p>
          <p
            className={cn(
              "mt-1 text-2xl font-bold tabular-nums",
              attention && "text-destructive",
            )}
          >
            {value}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
        </CardContent>
      </Link>
    </Card>
  );
}

export function OverviewTab({
  apiaryId,
  hives,
  hivesReady,
}: {
  apiaryId: string;
  hives: CanvasHive[];
  hivesReady: boolean;
}) {
  const weather = useApiaryWeather(apiaryId);
  const blooms = useBlooms(apiaryId, "active");

  const activeHives = hives.filter((hive) => hive.status === "active").length;
  const breakdown = statusBreakdown(hives);
  const feeding = weather.data?.feedingStatus;
  const activeBloomNames = (blooms.data ?? [])
    .map((bloom) => bloom.species)
    .slice(0, 2)
    .join(", ");

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!hivesReady ? (
          <Skeleton className="h-24" />
        ) : (
          <OverviewStat
            icon={Hexagon}
            label="Hives"
            value={String(hives.length)}
            sub={breakdown || `${activeHives} active`}
            href={`/yard/apiaries/${apiaryId}?tab=layout`}
          />
        )}
        {weather.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <OverviewStat
            icon={Droplets}
            label="Feeders"
            value={feeding ? String(feeding.activeFeeders) : "—"}
            sub={
              feeding?.needsAttention
                ? "Needs attention — see the dashboard"
                : feeding && feeding.activeFeeders > 0
                  ? "Open feeders in this yard"
                  : "No open feeders"
            }
            href="/today"
            attention={feeding?.needsAttention}
          />
        )}
        {blooms.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <OverviewStat
            icon={Flower2}
            label="In bloom"
            value={String(blooms.data?.length ?? 0)}
            sub={activeBloomNames || "Nothing recorded in bloom"}
            href={`/yard/apiaries/${apiaryId}/flora`}
          />
        )}
        <OverviewStat
          icon={Camera}
          label="Photos"
          value="Gallery"
          sub="View and add yard photos"
          href={`/yard/apiaries/${apiaryId}/photos`}
        />
      </div>

      <ForecastTab apiaryId={apiaryId} />
    </div>
  );
}
