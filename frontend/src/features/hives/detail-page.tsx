"use client";

/**
 * Hive detail bodies.
 *
 * Overview, Timeline and Health are routes under `/yard/hives/[id]`; the
 * record layout draws the header and the tab strip once and this component
 * renders the body for one of the three. Timeline subsets are URL-backed
 * filter chips (`?view=`), so a hive stays deep-linkable and coming back from
 * an inspection or a session detail does not reset the view.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Droplets } from "lucide-react";

import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSearchParamState } from "@/lib/url-state";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { FeedingDialog } from "@/features/feedings/feeding-dialog";
import {
  useHiveFeedings,
  useCloseFeeding,
  useRefillFeeding,
  useDeleteFeeding,
} from "@/features/feedings/hooks";
import { InspectionCard } from "@/features/inspections/inspection-card";
import { useHiveInspections } from "@/features/inspections/hooks";
import { HivePhotoStrip } from "@/features/photos/hive-strip";
import { HiveTimeline } from "@/features/operations/hive-timeline";
import type { HiveTimelineEntry } from "@/features/operations/hooks";
import { VarroaPanel } from "@/features/operations/varroa-panel";
import { FeedingsGrid, SplitsGrid } from "./hive-record-grids";
import { HiveOverviewTab } from "./overview-tab";
import { useHive, useHiveLocationHistory, useHiveSplits } from "./hooks";
import { formatDate } from "./lib";

export const HIVE_TABS = ["overview", "timeline", "health"] as const;
export type HiveTab = (typeof HIVE_TABS)[number];

/**
 * Timeline filter chips. `types` filters the merged timeline; the four chips
 * that replaced whole tabs render the richer list instead so their per-row
 * actions (edit an inspection, mark a feeder empty) survive.
 */
const TIMELINE_FILTERS: {
  value: string;
  label: string;
  types?: readonly HiveTimelineEntry["type"][];
}[] = [
  { value: "all", label: "All" },
  { value: "inspections", label: "Inspections" },
  { value: "feedings", label: "Feedings" },
  { value: "treatments", label: "Treatments", types: ["treatment"] },
  { value: "mites", label: "Mite counts", types: ["mite_count"] },
  { value: "queen", label: "Queen events", types: ["queen_event"] },
  { value: "harvests", label: "Harvests", types: ["harvest"] },
  { value: "splits", label: "Splits" },
  { value: "moves", label: "Moves" },
];

const FILTER_VALUES = TIMELINE_FILTERS.map((filter) => filter.value);

/**
 * The body of the Overview, Timeline and Health tabs. The record header, the
 * action bar and the tab strip belong to `HiveRecordLayout`; this renders
 * only what changes between those three tabs.
 */
export function HiveDetailPage({
  hiveId,
  section = "overview",
}: {
  hiveId: string;
  section?: HiveTab;
}) {
  const router = useRouter();
  const hive = useHive(hiveId);
  const access = useAccessProfile();
  const canEdit =
    hive.data != null &&
    ["admin", "editor"].includes(
      apiaryRole(access.data, hive.data.apiaryId) ?? "",
    );
  const [filter, setFilter] = useSearchParamState("view", "all", FILTER_VALUES);
  const [feedOpen, setFeedOpen] = React.useState(false);

  if (hive.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (hive.isError || !hive.data) return null;
  const data = hive.data;
  const activeFilter =
    TIMELINE_FILTERS.find((entry) => entry.value === filter) ??
    TIMELINE_FILTERS[0];

  return (
    <div className="grid grid-cols-1 gap-6">
      {section === "overview" && (
        <section>
          <HiveOverviewTab hiveId={data.id} canEdit={canEdit} />
        </section>
      )}
      {section === "timeline" && (
        <section className="flex min-w-0 flex-col gap-4">
          <div className="relative min-w-0">
            <div
              className="-my-1 flex snap-x gap-1.5 overflow-x-auto py-1 md:flex-wrap"
              role="group"
              aria-label="Filter the timeline"
            >
              {TIMELINE_FILTERS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  aria-pressed={entry.value === activeFilter.value}
                  onClick={() => setFilter(entry.value)}
                  className={cn(
                    "shrink-0 snap-start rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    entry.value === activeFilter.value
                      ? "border-primary bg-primary/12 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent md:hidden"
            />
          </div>
          {activeFilter.value === "inspections" ? (
            <InspectionsList hiveId={data.id} canEdit={canEdit} />
          ) : activeFilter.value === "feedings" ? (
            <FeedingsList
              hiveId={data.id}
              canEdit={canEdit}
              onNew={() => setFeedOpen(true)}
            />
          ) : activeFilter.value === "splits" ? (
            <SplitsList hiveId={data.id} />
          ) : activeFilter.value === "moves" ? (
            <LocationHistory hiveId={data.id} />
          ) : (
            <HiveTimeline hiveId={data.id} types={activeFilter.types} />
          )}
        </section>
      )}
      {section === "health" && (
        <section className="grid gap-5">
          <VarroaPanel hiveId={data.id} canEdit={canEdit} />
          <InspectionSummary
            hiveId={data.id}
            canEdit={canEdit}
            onSeeAll={() => {
              router.push(`/yard/hives/${data.id}/timeline?view=inspections`);
            }}
          />
          <HivePhotoStrip hiveId={data.id} canEdit={canEdit} />
        </section>
      )}

      {section === "overview" && data.notes && (
        <div className="rounded-xl border bg-card p-4 text-sm">
          <h2 className="mb-1 text-sm font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap">{data.notes}</p>
        </div>
      )}

      <FeedingDialog
        open={feedOpen}
        onOpenChange={setFeedOpen}
        hiveId={data.id}
      />
    </div>
  );
}

/** Health tab: inspection cadence at a glance plus the latest write-ups. */
function InspectionSummary({
  hiveId,
  canEdit,
  onSeeAll,
}: {
  hiveId: string;
  canEdit: boolean;
  onSeeAll: () => void;
}) {
  const inspections = useHiveInspections(hiveId);
  if (inspections.isPending) return <Skeleton className="h-40 w-full" />;
  if (inspections.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load inspections.
      </p>
    );
  }
  const all = [...inspections.data].sort((a, b) => b.date.localeCompare(a.date));
  const latest = all[0];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Inspection summary</CardTitle>
        {all.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onSeeAll}>
            All {all.length}
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {all.length === 0 ? (
          <p className="text-sm text-muted-foreground">No inspections yet.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {all.length} {all.length === 1 ? "inspection" : "inspections"} on
              record · last {formatDate(latest.date)}
            </p>
            <div className="grid gap-3">
              {all.slice(0, 3).map((inspection) => (
                <InspectionCard
                  key={inspection.id}
                  inspection={inspection}
                  canEdit={canEdit}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function InspectionsList({
  hiveId,
  canEdit,
}: {
  hiveId: string;
  canEdit: boolean;
}) {
  const inspections = useHiveInspections(hiveId);
  if (inspections.isPending) return <Skeleton className="h-32 w-full" />;
  if (inspections.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load inspections.
      </p>
    );
  }
  if (inspections.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No inspections yet.</p>
    );
  }
  return (
    <div className="grid gap-3">
      {inspections.data.map((inspection) => (
        <InspectionCard
          key={inspection.id}
          inspection={inspection}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}

function FeedingsList({
  hiveId,
  onNew,
  canEdit,
}: {
  hiveId: string;
  onNew: () => void;
  canEdit: boolean;
}) {
  const feedings = useHiveFeedings(hiveId);
  const closeFeeding = useCloseFeeding();
  const refillFeeding = useRefillFeeding();
  const deleteFeeding = useDeleteFeeding();

  async function onClose(id: string, reason: string, success: string) {
    try {
      await closeFeeding.mutateAsync({ id, reason });
      toast.success(success);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not close the feeder",
      );
    }
  }

  async function onRefill(id: string) {
    try {
      await refillFeeding.mutateAsync({ id });
      toast.success("Feeder refilled");
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not refill the feeder",
      );
    }
  }

  async function onDelete(id: string) {
    try {
      await deleteFeeding.mutateAsync(id);
      toast.success("Feeding deleted");
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not delete the feeding",
      );
    }
  }

  return (
    <div className="grid gap-4">
      {canEdit ? <div className="flex justify-end">
        <Button size="sm" onClick={onNew}>
          <Droplets className="size-4" />
          New feeding
        </Button>
      </div> : null}
      {feedings.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (feedings.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">No feedings recorded.</p>
      ) : (
        <FeedingsGrid
          feedings={feedings.data ?? []}
          canEdit={canEdit}
          actions={{
            onRefill,
            onClose,
            onDelete,
            refilling: refillFeeding.isPending,
            closing: closeFeeding.isPending,
            deleting: deleteFeeding.isPending,
          }}
        />
      )}
    </div>
  );
}

function SplitsList({ hiveId }: { hiveId: string }) {
  const splits = useHiveSplits(hiveId);
  if (splits.isPending) return <Skeleton className="h-24 w-full" />;
  if ((splits.data?.length ?? 0) === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This hive has no recorded splits.
      </p>
    );
  }
  return <SplitsGrid hiveId={hiveId} splits={splits.data ?? []} />;
}

function LocationHistory({ hiveId }: { hiveId: string }) {
  const history = useHiveLocationHistory(hiveId);
  if (history.isPending) return <Skeleton className="h-24 w-full" />;
  if ((history.data?.length ?? 0) === 0) {
    return (
      <p className="text-sm text-muted-foreground">No location history.</p>
    );
  }
  return (
    <ol className="relative grid gap-4 border-l pl-4">
      {history.data?.map((entry) => (
        <li key={entry.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-primary" />
          <p className="text-sm font-medium">
            {entry.apiaryName} — {entry.positionLabel}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDate(entry.dateFrom)} –{" "}
            {entry.dateTo ? formatDate(entry.dateTo) : "present"}
          </p>
        </li>
      ))}
    </ol>
  );
}
