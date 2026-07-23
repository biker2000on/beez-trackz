"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  Flower2,
  Hexagon,
  LayoutDashboard,
  ListChecks,
  MapPin,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcut } from "@/components/shortcuts/provider";
import ApiaryCanvas from "@/features/canvas";
import { useApiaryHives } from "@/features/canvas/lib/use-canvas-data";
import { PhotoSection } from "@/features/photos/photo-gallery";

import { ApiaryFormDialog } from "./apiary-form-dialog";
import { BulkActionsTab } from "./bulk-actions-tab";
import { DeleteApiaryDialog } from "./delete-apiary-dialog";
import { FloraTab } from "./flora-tab";
import { useApiary } from "./hooks";

export function ApiaryDetailPage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);
  const hives = useApiaryHives(apiaryId);
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  useShortcut("e", "Edit apiary", () => setEditOpen(true));

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
                </span>
              )}
            </div>
            {detail.notes && (
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {detail.notes}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${detail.name}`}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </header>

      <Tabs defaultValue="layout" className="min-w-0">
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList className="h-11 min-w-max">
            <TabsTrigger value="layout" className="h-9">
              <LayoutDashboard />
              Layout
            </TabsTrigger>
            <TabsTrigger value="flora" className="h-9">
              <Flower2 />
              Flora
            </TabsTrigger>
            <TabsTrigger value="bulk" className="h-9">
              <ListChecks />
              Bulk record
            </TabsTrigger>
            <TabsTrigger value="photos" className="h-9">
              <Camera />
              Photos
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="layout" className="min-w-0">
          <ApiaryCanvas apiaryId={apiaryId} />
        </TabsContent>
        <TabsContent value="flora">
          <FloraTab apiaryId={apiaryId} />
        </TabsContent>
        <TabsContent value="bulk">
          <BulkActionsTab apiaryId={apiaryId} />
        </TabsContent>
        <TabsContent value="photos">
          <PhotoSection ownerType="apiary" ownerId={apiaryId} />
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
