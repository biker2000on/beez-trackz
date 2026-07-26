"use client";

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
  Pencil,
  Skull,
  Split,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  useMarkFeedingEmpty,
  useDeleteFeeding,
} from "@/features/feedings/hooks";
import { InspectionCard } from "@/features/inspections/inspection-card";
import { InspectionFormDialog } from "@/features/inspections/inspection-form-dialog";
import { useHiveInspections } from "@/features/inspections/hooks";
import { PhotoSection } from "@/features/photos/photo-gallery";
import { PhotoUpload } from "@/features/photos/photo-upload";
import { HiveTimeline } from "@/features/operations/hive-timeline";
import { VarroaPanel } from "@/features/operations/varroa-panel";
import { EquipmentTab } from "./equipment-tab";
import { HiveStatusBadge } from "./hive-card";
import { HiveFormDialog } from "./hive-form-dialog";
import {
  useArchiveHive,
  useDeadoutHive,
  useHive,
  useHiveLocationHistory,
  useHiveSplits,
  useUnarchiveHive,
} from "./hooks";
import { formatDate } from "./lib";
import { QueenTab } from "./queen-tab";
import { SplitDialog } from "./split-dialog";

export function HiveDetailPage({ hiveId }: { hiveId: string }) {
  const router = useRouter();
  const hive = useHive(hiveId);

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

  useShortcut("i", "New inspection", () => setInspectionOpen(true));
  useShortcut("r", "Record inspection by voice", () =>
    router.push(`/hives/${hiveId}/transcribe`),
  );
  useShortcut("f", "Record feeding", () => setFeedOpen(true));
  useShortcut("p", "Add photo", () => setPhotoOpen(true));
  useShortcut("e", "Edit hive", () => setEditOpen(true));
  useShortcut("s", "Split hive", () => setSplitOpen(true));

  if (hive.isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit hive"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-4" />
          </Button>
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
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setInspectionOpen(true)}>
          <ClipboardList className="size-4" />
          New inspection
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href={`/hives/${data.id}/transcribe`}>
            <Mic className="size-4" />
            Record inspection
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={() => setFeedOpen(true)}>
          <Droplets className="size-4" />
          Feed
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPhotoOpen(true)}>
          <Camera className="size-4" />
          Take photo
        </Button>
        <Button size="sm" variant="outline" onClick={() => setSplitOpen(true)}>
          <Split className="size-4" />
          Split hive
        </Button>
        {data.isArchived ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              run(() => unarchiveHive.mutateAsync(data.id), "Hive unarchived")
            }
            disabled={unarchiveHive.isPending}
          >
            <ArchiveRestore className="size-4" />
            Unarchive
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setArchiveOpen(true)}
            >
              <Archive className="size-4" />
              Archive
            </Button>
            {data.status !== "dead" && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeadoutOpen(true)}
              >
                <Skull className="size-4" />
                Deadout
              </Button>
            )}
          </>
        )}
      </div>

      <Tabs defaultValue="timeline">
        <TabsList className="flex w-full flex-wrap justify-start overflow-x-auto">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="inspections">Inspections</TabsTrigger>
          <TabsTrigger value="varroa">Varroa</TabsTrigger>
          <TabsTrigger value="equipment">Equipment</TabsTrigger>
          <TabsTrigger value="photos">Photos</TabsTrigger>
          <TabsTrigger value="feedings">Feedings</TabsTrigger>
          <TabsTrigger value="queen">Queen</TabsTrigger>
          <TabsTrigger value="splits">Splits</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="pt-4">
          <HiveTimeline hiveId={data.id} />
        </TabsContent>
        <TabsContent value="inspections" className="pt-4">
          <InspectionsTab hiveId={data.id} />
        </TabsContent>
        <TabsContent value="varroa" className="pt-4">
          <VarroaPanel hiveId={data.id} />
        </TabsContent>
        <TabsContent value="equipment" className="pt-4">
          <EquipmentTab hiveId={data.id} />
        </TabsContent>
        <TabsContent value="photos" className="pt-4">
          <PhotoSection ownerType="hive" ownerId={data.id} />
        </TabsContent>
        <TabsContent value="feedings" className="pt-4">
          <FeedingsTab hiveId={data.id} onNew={() => setFeedOpen(true)} />
        </TabsContent>
        <TabsContent value="queen" className="pt-4">
          <QueenTab hiveId={data.id} />
        </TabsContent>
        <TabsContent value="splits" className="pt-4">
          <SplitsTab hiveId={data.id} />
        </TabsContent>
        <TabsContent value="history" className="pt-4">
          <HistoryTab hiveId={data.id} />
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

function InspectionsTab({ hiveId }: { hiveId: string }) {
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
        <InspectionCard key={inspection.id} inspection={inspection} />
      ))}
    </div>
  );
}

function FeedingsTab({
  hiveId,
  onNew,
}: {
  hiveId: string;
  onNew: () => void;
}) {
  const feedings = useHiveFeedings(hiveId);
  const markEmpty = useMarkFeedingEmpty();
  const deleteFeeding = useDeleteFeeding();

  async function onMarkEmpty(id: string) {
    try {
      await markEmpty.mutateAsync(id);
      toast.success("Feeder marked empty");
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not mark the feeder empty",
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
      <div className="flex justify-end">
        <Button size="sm" onClick={onNew}>
          <Droplets className="size-4" />
          New feeding
        </Button>
      </div>
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
                  {feeding.dateEmpty
                    ? ` · empty ${formatDate(feeding.dateEmpty)}`
                    : " · still out"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!feeding.dateEmpty && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onMarkEmpty(feeding.id)}
                    disabled={markEmpty.isPending}
                  >
                    Mark empty
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
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SplitsTab({ hiveId }: { hiveId: string }) {
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

function HistoryTab({ hiveId }: { hiveId: string }) {
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
