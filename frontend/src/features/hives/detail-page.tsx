"use client";

/**
 * Hive detail.
 *
 * The strip used to carry nine tabs. It now has three peer views: a default
 * Overview, Timeline, and Health. Equipment, Queen, and Photos are dedicated
 * drill-down routes reached from the overview; timeline subsets remain URL-
 * backed filter chips rather than competing peer tabs.
 *
 * Both the active tab and the active chip live in search params, so a hive is
 * deep-linkable and coming back from an inspection or a session detail does
 * not reset the view.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Camera,
  ClipboardList,
  Droplets,
  MapPin,
  Mic,
  MoreHorizontal,
  Pencil,
  Skull,
  Split,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSearchParamState, useSetSearchParams } from "@/lib/url-state";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { FeedingDialog } from "@/features/feedings/feeding-dialog";
import {
  feederTypeLabel,
  feedingTypeLabel,
  useHiveFeedings,
  useCloseFeeding,
  useRefillFeeding,
  useDeleteFeeding,
} from "@/features/feedings/hooks";
import { InspectionCard } from "@/features/inspections/inspection-card";
import { InspectionFormDialog } from "@/features/inspections/inspection-form-dialog";
import { useHiveInspections } from "@/features/inspections/hooks";
import { PhotoUpload } from "@/features/photos/photo-upload";
import { HiveTimeline } from "@/features/operations/hive-timeline";
import type { HiveTimelineEntry } from "@/features/operations/hooks";
import { VarroaPanel } from "@/features/operations/varroa-panel";
import { HiveStatusBadge } from "./hive-card";
import { HiveFormDialog } from "./hive-form-dialog";
import { HiveOverviewTab } from "./overview-tab";
import {
  useArchiveHive,
  useDeadoutHive,
  useHive,
  useHiveLocationHistory,
  useHiveSplits,
  useUnarchiveHive,
} from "./hooks";
import { formatDate } from "./lib";
import { SplitDialog } from "./split-dialog";

export const HIVE_TABS = ["overview", "timeline", "health"] as const;

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

export function HiveDetailPage({ hiveId }: { hiveId: string }) {
  const router = useRouter();
  const hive = useHive(hiveId);
  const access = useAccessProfile();
  const canEdit =
    hive.data != null &&
    ["admin", "editor"].includes(
      apiaryRole(access.data, hive.data.apiaryId) ?? "",
    );

  const [tab, setTab] = useSearchParamState("tab", "overview", HIVE_TABS);
  const [filter, setFilter] = useSearchParamState("view", "all", FILTER_VALUES);
  const setSearchParams = useSetSearchParams();

  const [editOpen, setEditOpen] = React.useState(false);
  const [inspectionOpen, setInspectionOpen] = React.useState(false);
  const [feedOpen, setFeedOpen] = React.useState(false);
  const [photoOpen, setPhotoOpen] = React.useState(false);
  const [splitOpen, setSplitOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [deadoutOpen, setDeadoutOpen] = React.useState(false);

  const archiveHive = useArchiveHive();
  const unarchiveHive = useUnarchiveHive();
  const deadoutHive = useDeadoutHive();

  // Every one of these writes; a viewer gets none of them registered, so the
  // `?` dialog and the command palette stop offering actions that do nothing.
  const editable = { enabled: canEdit };
  useShortcut("i", "New inspection", () => setInspectionOpen(true), editable);
  useShortcut(
    "r",
    "Record inspection by voice",
    () => router.push(`/hives/${hiveId}/transcribe`),
    editable,
  );
  useShortcut("f", "Record feeding", () => setFeedOpen(true), editable);
  useShortcut("p", "Add photo", () => setPhotoOpen(true), editable);
  useShortcut("e", "Edit hive", () => setEditOpen(true), editable);
  // `t`, not `x` (globally select-all, DESIGN.md) and not `s` (Record sale on
  // Honey, and the tail of `g s` for Settings).
  useShortcut("t", "Split hive", () => setSplitOpen(true), editable);

  if (hive.isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        {/* The action bar is `size="sm"` buttons (h-8); reserving the row
            keeps the tabs and content from jumping when the hive lands. */}
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-36 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
        <Skeleton className="h-9 w-full max-w-xl" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (hive.isError || !hive.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load this hive.{" "}
        <Link
          href="/hives"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Back to hives
        </Link>
      </p>
    );
  }
  const data = hive.data;
  const activeFilter =
    TIMELINE_FILTERS.find((entry) => entry.value === filter) ??
    TIMELINE_FILTERS[0];

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Something went wrong",
      );
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">
            {data.positionLabel}
          </h1>
          <HiveStatusBadge status={data.status} />
          {data.isArchived && (
            <Badge variant="outline" className="gap-1">
              <Archive className="size-3" />
              Archived
            </Badge>
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <Link
            href={`/apiaries/${data.apiaryId}`}
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <MapPin className="size-3.5 text-primary" />
            {data.apiaryName}
          </Link>
          {data.installedDate && (
            <span>Installed {formatDate(data.installedDate)}</span>
          )}
          {data.deadoutDate && (
            <span className="text-destructive">
              Deadout {formatDate(data.deadoutDate)}
            </span>
          )}
        </p>
        {data.lockout?.locked && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            {data.lockout.message}
          </p>
        )}
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setInspectionOpen(true)}>
            <ClipboardList className="size-4" />
            New inspection
          </Button>
          <Button size="sm" variant="outline" onClick={() => setFeedOpen(true)}>
            <Droplets className="size-4" />
            Feed
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPhotoOpen(true)}>
            <Camera className="size-4" />
            Photo
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="More hive actions">
                <MoreHorizontal className="size-4" />
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem asChild>
                <Link href={`/hives/${data.id}/transcribe`}>
                  <Mic className="size-4" />
                  Record inspection by voice
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSplitOpen(true)}>
                <Split className="size-4" />
                Split hive
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <Pencil className="size-4" />
                Edit hive
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {data.isArchived ? (
                <DropdownMenuItem
                  disabled={unarchiveHive.isPending}
                  onSelect={() =>
                    void run(
                      () => unarchiveHive.mutateAsync(data.id),
                      "Hive unarchived",
                    )
                  }
                >
                  <ArchiveRestore className="size-4" />
                  Unarchive
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                  <Archive className="size-4" />
                  Archive
                </DropdownMenuItem>
              )}
              {!data.isArchived && data.status !== "dead" && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeadoutOpen(true)}
                >
                  <Skull className="size-4" />
                  Mark deadout
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        {/* Record tabs stay a scroll strip on mobile (DESIGN.md). `py-1 -my-1`
            keeps the focus ring from being clipped by the scroll container. */}
        <div className="-my-1 -mx-4 snap-x scroll-px-4 overflow-x-auto px-4 py-1 md:mx-0 md:px-0">
          <TabsList className="min-w-max">
            <TabsTrigger value="overview" className="snap-start">
              Overview
            </TabsTrigger>
            <TabsTrigger value="timeline" className="snap-start">
              Timeline
            </TabsTrigger>
            <TabsTrigger value="health" className="snap-start">
              Health
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="pt-4">
          <HiveOverviewTab hiveId={data.id} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="timeline" className="grid gap-4 pt-4">
          <div className="relative -mx-4 md:mx-0">
            <div
              className="-my-1 flex snap-x scroll-px-4 gap-1.5 overflow-x-auto px-4 py-1 md:flex-wrap md:px-0"
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
        </TabsContent>
        <TabsContent value="health" className="grid gap-5 pt-4">
          <VarroaPanel hiveId={data.id} canEdit={canEdit} />
          <InspectionSummary
            hiveId={data.id}
            canEdit={canEdit}
            onSeeAll={() => {
              setSearchParams({ tab: "timeline", view: "inspections" });
            }}
          />
        </TabsContent>
      </Tabs>

      {data.notes && (
        <div className="rounded-xl border bg-card p-4 text-sm">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h2>
          <p className="whitespace-pre-wrap">{data.notes}</p>
        </div>
      )}

      <HiveFormDialog open={editOpen} onOpenChange={setEditOpen} hive={data} />
      <InspectionFormDialog
        open={inspectionOpen}
        onOpenChange={setInspectionOpen}
        hiveId={data.id}
      />
      <FeedingDialog
        open={feedOpen}
        onOpenChange={setFeedOpen}
        hiveId={data.id}
      />
      <SplitDialog open={splitOpen} onOpenChange={setSplitOpen} hive={data} />

      <Dialog open={photoOpen} onOpenChange={setPhotoOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add photo</DialogTitle>
            <DialogDescription>
              Attach a photo to {data.positionLabel}.
            </DialogDescription>
          </DialogHeader>
          <PhotoUpload
            ownerType="hive"
            ownerId={data.id}
            onUploaded={() => setPhotoOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {data.positionLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived hives are hidden from lists by default. You can
              unarchive at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run(async () => {
                  await archiveHive.mutateAsync(data.id);
                  setArchiveOpen(false);
                }, "Hive archived");
              }}
              disabled={archiveHive.isPending}
            >
              {archiveHive.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deadoutOpen} onOpenChange={setDeadoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {data.positionLabel} as a deadout?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The hive is marked dead with today&apos;s date and archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void run(async () => {
                  await deadoutHive.mutateAsync(data.id);
                  setDeadoutOpen(false);
                }, "Deadout recorded");
              }}
              disabled={deadoutHive.isPending}
            >
              {deadoutHive.isPending ? "Saving…" : "Mark deadout"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        <ul className="grid gap-2">
          {feedings.data?.map((feeding) => (
            <li
              key={feeding.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {feedingTypeLabel(feeding.type)} — {feeding.quantity}{" "}
                  {feeding.quantityUnit}
                </p>
                <p className="text-xs text-muted-foreground">
                  Fed {formatDate(feeding.dateFed)}
                  {feeding.feederType &&
                    ` · ${feederTypeLabel(feeding.feederType)}`}
                  {feeding.status === "closed"
                    ? ` · closed ${formatDate(feeding.dateEmpty ?? feeding.closedAt ?? feeding.dateFed)}`
                    : feeding.status === "unverified"
                      ? " · no recorded end — verify in the field"
                      : " · feeder on the hive"}
                </p>
              </div>
              {canEdit ? <div className="flex items-center gap-2">
                {feeding.status === "open" && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRefill(feeding.id)}
                      disabled={refillFeeding.isPending}
                    >
                      Refill
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onClose(feeding.id, "emptied", "Feeder closed")
                      }
                      disabled={closeFeeding.isPending}
                    >
                      Close
                    </Button>
                  </>
                )}
                {feeding.status === "unverified" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onClose(
                        feeding.id,
                        "verified_closed",
                        "Verified — no feeder on the hive",
                      )
                    }
                    disabled={closeFeeding.isPending}
                  >
                    Verify &amp; close
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(feeding.id)}
                  disabled={deleteFeeding.isPending}
                >
                  Delete
                </Button>
              </div> : null}
            </li>
          ))}
        </ul>
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
  return (
    <ul className="grid gap-2">
      {splits.data?.map((split) => {
        const isParent = split.parentHiveId === hiveId;
        const otherId = isParent ? split.childHiveId : split.parentHiveId;
        const otherLabel = isParent ? split.childLabel : split.parentLabel;
        return (
          <li
            key={split.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {isParent ? "Split into" : "Split from"}{" "}
                <Link
                  href={`/hives/${otherId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {otherLabel}
                </Link>
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(split.splitDate)} · {split.splitType}
                {split.framesMoved != null &&
                  ` · ${split.framesMoved} frames moved`}
              </p>
              {split.notes && (
                <p className="text-xs text-muted-foreground">{split.notes}</p>
              )}
            </div>
            <Badge variant={isParent ? "secondary" : "outline"}>
              {isParent ? "Parent" : "Child"}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
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
