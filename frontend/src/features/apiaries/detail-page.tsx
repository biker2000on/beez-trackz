"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Hexagon,
  LayoutDashboard,
  ListChecks,
  Map,
  MapPin,
  Mic,
  Pencil,
  Trash2,
  QrCode,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcut } from "@/components/shortcuts/provider";
import { useSearchParamState } from "@/lib/url-state";
import ApiaryCanvas from "@/features/canvas";
import { useApiaryHives } from "@/features/canvas/lib/use-canvas-data";

import { ApiaryFormDialog } from "./apiary-form-dialog";
import { DeleteApiaryDialog } from "./delete-apiary-dialog";
import { OverviewTab } from "./overview-tab";
import { useApiary } from "./hooks";
import { formatElevationM } from "@/features/map/elevation";
import { apiaryRole, useAccessProfile } from "@/features/access/api";

// Overview and Layout are the only peer views. Flora, Photos, and bulk
// recording are dedicated routes reached from the overview/header.
export const APIARY_TABS = ["overview", "layout"] as const;

export function ApiaryDetailPage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);
  const hives = useApiaryHives(apiaryId);
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  // Deep-linkable and back-button safe: the active tab lives in the URL.
  const [tab, setTab] = useSearchParamState("tab", "overview", APIARY_TABS);

  useShortcut(
    "e",
    "Edit apiary",
    () => {
      if (canEdit) setEditOpen(true);
    },
    { enabled: canEdit },
  );

  if (apiary.isPending) {
    return (
      <div className="grid gap-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-11 w-full max-w-xl" />
        <Skeleton className="h-[430px] rounded-xl" />
      </div>
    );
  }

  if (apiary.isError) {
    return (
      <div className="grid min-h-64 place-items-center rounded-xl border border-dashed p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">Could not load this apiary</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been removed, or the server may be unavailable.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/apiaries">Back to apiaries</Link>
            </Button>
            <Button onClick={() => apiary.refetch()}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  const detail = apiary.data;
  return (
    <div className="grid gap-5">
      <header className="grid gap-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-3 w-fit text-muted-foreground"
        >
          <Link href="/apiaries">
            <ArrowLeft />
            Apiaries
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">
              {detail.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Hexagon className="size-4" />
                {hives.data?.length ?? 0}{" "}
                {hives.data?.length === 1 ? "hive" : "hives"}
              </span>
              {detail.latitude != null && detail.longitude != null && (
                <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                  <MapPin className="size-4" />
                  {detail.latitude.toFixed(4)}, {detail.longitude.toFixed(4)}
                  {formatElevationM(detail.elevationM, detail.elevationSource)
                    ? ` · ${formatElevationM(detail.elevationM, detail.elevationSource)}`
                    : ""}
                </span>
              )}
            </div>
            {detail.notes && (
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {detail.notes}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canEdit ? (
              <>
                {/* Batch transcription used to be an orphan route with no
                    inbound link; the yard you are standing in is its natural
                    entry point. */}
                <Button asChild variant="outline">
                  <Link href={`/transcribe?apiary=${apiaryId}`}>
                    <Mic />
                    Voice walkthrough
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={`/apiaries/${apiaryId}/bulk`}>
                    <ListChecks />
                    Bulk record
                  </Link>
                </Button>
              </>
            ) : null}
            <Button asChild variant="outline">
              <Link href={`/apiaries/${apiaryId}/labels`}>
                <QrCode />
                Print tags
              </Link>
            </Button>
            {canEdit ? (
              <>
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil />
                  Edit
                </Button>
                {access.data?.isAdmin ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${detail.name}`}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="min-w-0">
        {/* Record tabs stay a scroll strip on mobile (DESIGN.md). `py-1 -my-1`
            keeps the focus ring from being clipped by the scroll container. */}
        <div className="-my-1 -mx-4 snap-x scroll-px-4 overflow-x-auto px-4 py-1 md:mx-0 md:px-0">
          <TabsList className="min-h-11 min-w-max">
            <TabsTrigger value="overview" className="min-h-9 snap-start">
              <LayoutDashboard />
              Overview
            </TabsTrigger>
            <TabsTrigger value="layout" className="min-h-9 snap-start">
              <Map />
              Layout
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab
            apiaryId={apiaryId}
            hives={hives.data ?? []}
            hivesReady={!hives.isPending}
          />
        </TabsContent>
        <TabsContent value="layout" className="min-w-0">
          <div className="relative">
            {!canEdit ? (
              <span className="absolute right-3 top-3 z-20 rounded-full border bg-background/90 px-2 py-1 text-xs font-medium shadow-sm">
                View only
              </span>
            ) : null}
            <div className={!canEdit ? "pointer-events-none" : undefined}>
              <ApiaryCanvas apiaryId={apiaryId} />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <ApiaryFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        apiary={detail}
      />
      <DeleteApiaryDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        apiaryId={apiaryId}
        apiaryName={detail.name}
      />
    </div>
  );
}
