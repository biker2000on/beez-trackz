"use client";

/**
 * The hive record's shared frame (`/yard/hives/[id]/*`): one header, one
 * action bar, one tab strip, rendered by the route layout so Overview,
 * Timeline, Health, Equipment, Queen and Photos cannot drift apart. The tabs
 * come from `contextualNavRoutes`; the pages under this layout render only
 * their body.
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
  Pencil,
  RotateCcw,
  Skull,
  Split,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  RecordHeader,
  RecordHeaderSkeleton,
  useRecordActions,
  useRecordTabs,
} from "@/components/record/record-header";
import { useShortcut } from "@/components/shortcuts/provider";

import { FeedingDialog } from "@/features/feedings/feeding-dialog";
import { InspectionFormDialog } from "@/features/inspections/inspection-form-dialog";
import { PhotoUpload } from "@/features/photos/photo-upload";
import { HiveStatusBadge } from "./hive-card";
import { HiveFormDialog } from "./hive-form-dialog";
import {
  useArchiveHive,
  useHive,
  useUnarchiveHive,
  useUpdateHive,
  type Hive,
} from "./hooks";
import { DeadoutAutopsyDialog } from "./deadout-autopsy-dialog";
import { formatDate, HIVE_STATUS_LABELS, type HiveStatus } from "./lib";

/**
 * A sold, dead, combined or archived hive is history: nothing is inspected
 * or fed any more, so the field actions leave the bar and the one thing left
 * to do — bring it back — is the primary.
 */
function hiveReadOnly(hive: Hive): boolean {
  return hive.isArchived || hive.status !== "active";
}

/** "Dead Apr 24, 2026 · records are read-only" — the header's one-line notice. */
function readOnlyNotice(hive: Hive): string {
  const word =
    hive.isArchived && hive.status === "active"
      ? "Archived"
      : (HIVE_STATUS_LABELS[hive.status as HiveStatus] ?? hive.status);
  const date =
    hive.status === "dead" && hive.deadoutDate
      ? ` ${formatDate(hive.deadoutDate)}`
      : "";
  return `${word}${date} · records are read-only`;
}
import { SplitDialog } from "./split-dialog";

export function HiveRecordLayout({
  hiveId,
  children,
}: {
  hiveId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const hive = useHive(hiveId);
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;
  const canEdit =
    hive.data != null &&
    ["admin", "editor"].includes(
      apiaryRole(access.data, hive.data.apiaryId) ?? "",
    );
  const tabs = useRecordTabs("/yard/hives", isAdmin, canEdit);
  const [voice] = useRecordActions("/yard/hives", isAdmin, canEdit);

  const [editOpen, setEditOpen] = React.useState(false);
  const [inspectionOpen, setInspectionOpen] = React.useState(false);
  const [feedOpen, setFeedOpen] = React.useState(false);
  const [photoOpen, setPhotoOpen] = React.useState(false);
  const [splitOpen, setSplitOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [deadoutOpen, setDeadoutOpen] = React.useState(false);

  const archiveHive = useArchiveHive();
  const unarchiveHive = useUnarchiveHive();
  const updateHive = useUpdateHive(hiveId);
  const readOnly = hive.data != null && hiveReadOnly(hive.data);

  // Every one of these writes; a viewer gets none of them registered, so the
  // `?` dialog and the command palette stop offering actions that do nothing.
  // A read-only hive (sold, dead, archived) keeps only Edit.
  const editable = { enabled: canEdit && !readOnly };
  useShortcut("i", "Log inspection", () => setInspectionOpen(true), editable);
  useShortcut(
    "r",
    "Voice inspection",
    () => {
      if (voice) router.push(voice.href);
    },
    { enabled: canEdit && !readOnly && voice != null },
  );
  useShortcut("f", "Record feeding", () => setFeedOpen(true), editable);
  useShortcut("p", "Add photo", () => setPhotoOpen(true), editable);
  useShortcut("e", "Edit hive", () => setEditOpen(true), { enabled: canEdit });
  // `t`, not `x` (globally select-all, DESIGN.md) and not `s` (Record sale on
  // Honey, and the tail of `g s` for Settings).
  useShortcut("t", "Split hive", () => setSplitOpen(true), editable);

  if (hive.isPending) {
    return (
      <div className="grid gap-6">
        <RecordHeaderSkeleton tabs={6} />
        {children}
      </div>
    );
  }
  if (hive.isError || !hive.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load this hive.{" "}
        <Link
          href="/yard/hives"
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

  // `PUT /hives/{id}` replaces the whole record, so the payload carries every
  // field the form would send, with only the status changed.
  async function reactivate() {
    if (data.isArchived) await unarchiveHive.mutateAsync(data.id);
    if (data.status !== "active") {
      await updateHive.mutateAsync({
        apiaryId: data.apiaryId,
        positionLabel: data.positionLabel,
        standId: data.standId,
        slotRow: data.slotRow,
        slotCol: data.slotCol,
        placement: data.placement,
        status: "active",
        installedDate: data.installedDate,
        notes: data.notes,
      });
    }
  }
  const reactivating = unarchiveHive.isPending || updateHive.isPending;

  return (
    <div className="grid grid-cols-1 gap-6">
      <RecordHeader
        name={data.positionLabel}
        tabs={tabs}
        tabsLabel="Hive pages"
        status={
          <>
            <HiveStatusBadge status={data.status} />
            {data.isArchived && (
              <Badge variant="outline" className="gap-1">
                <Archive className="size-3" />
                Archived
              </Badge>
            )}
          </>
        }
        context={[
          <Link
            key="apiary"
            href={`/yard/apiaries/${data.apiaryId}`}
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <MapPin className="size-3.5 text-primary" aria-hidden />
            {data.apiaryName}
          </Link>,
          data.installedDate && `Installed ${formatDate(data.installedDate)}`,
          data.deadoutDate && (
            <span key="deadout" className="text-destructive">
              Deadout {formatDate(data.deadoutDate)}
            </span>
          ),
        ]}
        primary={
          !canEdit ? undefined : readOnly ? (
            <Button
              disabled={reactivating}
              onClick={() =>
                void run(reactivate, `${data.positionLabel} is active again`)
              }
            >
              <RotateCcw className="size-4" />
              {reactivating ? "Reactivating…" : "Reactivate"}
            </Button>
          ) : voice ? (
            <Button asChild>
              <Link href={voice.href}>
                <Mic className="size-4" />
                {voice.label}
              </Link>
            </Button>
          ) : undefined
        }
        secondary={
          canEdit && !readOnly ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setInspectionOpen(true)}>
                <ClipboardList className="size-4" />
                Log inspection
              </Button>
              <Button size="sm" variant="outline" onClick={() => setFeedOpen(true)}>
                <Droplets className="size-4" />
                Feed
              </Button>
            </>
          ) : undefined
        }
        more={
          canEdit ? (
            <>
              {!readOnly ? (
                <>
                  <DropdownMenuItem onSelect={() => setPhotoOpen(true)}>
                    <Camera className="size-4" />
                    Add photo
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setSplitOpen(true)}>
                    <Split className="size-4" />
                    Split hive
                  </DropdownMenuItem>
                </>
              ) : null}
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
            </>
          ) : undefined
        }
      >
        {readOnly && (
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="hive-read-only"
          >
            {readOnlyNotice(data)}
            {data.saleId ? (
              <>
                {" · "}
                <Link
                  href={`/sales/${data.saleId}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Open order
                </Link>
              </>
            ) : null}
          </p>
        )}
        {data.lockout?.locked && (
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            {data.lockout.message}
          </p>
        )}
      </RecordHeader>

      {children}

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

      <DeadoutAutopsyDialog
        open={deadoutOpen}
        onOpenChange={setDeadoutOpen}
        hiveId={data.id}
        hiveName={data.positionLabel}
      />
    </div>
  );
}
