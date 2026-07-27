"use client";

import * as React from "react";
import Link from "next/link";
import { CheckSquare, Hexagon, MapPin, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";
import { useAccessProfile } from "@/features/access/api";
import { ApiaryFormDialog } from "./apiary-form-dialog";
import { useApiaries, useBulkDeleteApiaries } from "./hooks";

export function ApiariesListPage() {
  const apiaries = useApiaries();
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;
  const bulkDelete = useBulkDeleteApiaries();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [bulkMode, setBulkMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  useShortcut("n", "New apiary", () => isAdmin && setCreateOpen(true));
  useShortcut("b", "Toggle bulk select", () => {
    if (!isAdmin) return;
    setBulkMode((active) => {
      if (active) setSelected(new Set());
      return !active;
    });
  });
  useShortcut("x", "Select all apiaries", () => {
    if (!isAdmin || !bulkMode) return;
    setSelected(
      selected.size === (apiaries.data?.length ?? 0)
        ? new Set()
        : new Set((apiaries.data ?? []).map((apiary) => apiary.id)),
    );
  });

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    const result = await bulkDelete.mutateAsync(Array.from(selected));
    if (result.deleted > 0) {
      toast.success(
        result.deleted === 1
          ? "Apiary deleted"
          : `${result.deleted} apiaries deleted`,
      );
    }
    if (result.failed > 0) {
      toast.error(
        `${result.failed} apiar${result.failed === 1 ? "y" : "ies"} could not be deleted`,
        { description: "Apiaries containing hives are protected." },
      );
    }
    setSelected(new Set());
    setBulkMode(false);
    setConfirmDelete(false);
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Apiaries</h1>
        {isAdmin ? <div className="flex gap-2">
          <Button
            variant={bulkMode ? "secondary" : "outline"}
            onClick={() => {
              setBulkMode((active) => !active);
              setSelected(new Set());
            }}
          >
            <CheckSquare />
            {bulkMode ? "Done" : "Bulk select"}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New apiary
          </Button>
        </div> : null}
      </div>

      {apiaries.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : apiaries.isError ? (
        <p className="text-sm text-muted-foreground">
          Could not load apiaries.{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => apiaries.refetch()}
          >
            Retry
          </button>
        </p>
      ) : apiaries.data.length === 0 ? (
        <Card>
          <CardContent className="grid place-items-center gap-3 py-10 text-center">
            <MapPin className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No apiaries yet. Create your first yard to start tracking hives.
            </p>
            {isAdmin ? <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New apiary
            </Button> : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apiaries.data.map((apiary) =>
            bulkMode ? (
              <button
                key={apiary.id}
                type="button"
                className="text-left"
                onClick={() => toggleSelected(apiary.id)}
              >
                <Card
                  className={`h-full transition-colors ${
                    selected.has(apiary.id)
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/50"
                  }`}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2">
                      <Checkbox
                        checked={selected.has(apiary.id)}
                        tabIndex={-1}
                        aria-hidden="true"
                        className="pointer-events-none"
                      />
                      <MapPin className="size-4 text-primary" />
                      {apiary.name}
                    </CardTitle>
                    {apiary.latitude != null && apiary.longitude != null && (
                      <CardDescription className="font-mono text-xs">
                        {apiary.latitude.toFixed(4)},{" "}
                        {apiary.longitude.toFixed(4)}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Hexagon className="size-4" />
                    {apiary.hiveCount}{" "}
                    {apiary.hiveCount === 1 ? "hive" : "hives"}
                  </CardContent>
                </Card>
              </button>
            ) : (
              <Link key={apiary.id} href={`/apiaries/${apiary.id}`}>
                <Card className="h-full transition-colors hover:border-primary/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2">
                    <MapPin className="size-4 text-primary" />
                    {apiary.name}
                  </CardTitle>
                  {apiary.latitude != null && apiary.longitude != null && (
                    <CardDescription className="font-mono text-xs">
                      {apiary.latitude.toFixed(4)},{" "}
                      {apiary.longitude.toFixed(4)}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Hexagon className="size-4" />
                  {apiary.hiveCount} {apiary.hiveCount === 1 ? "hive" : "hives"}
                </CardContent>
              </Card>
              </Link>
            ),
          )}
        </div>
      )}

      {isAdmin && bulkMode && (
        <div className="sticky bottom-20 z-20 flex items-center gap-2 rounded-xl border bg-card p-3 shadow-lg md:bottom-4">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(
                selected.size === (apiaries.data?.length ?? 0)
                  ? new Set()
                  : new Set(
                      (apiaries.data ?? []).map((apiary) => apiary.id),
                    ),
              )
            }
          >
            {selected.size === (apiaries.data?.length ?? 0)
              ? "Clear all"
              : "Select all"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={selected.size === 0}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
            Delete
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Exit bulk select"
            onClick={() => {
              setBulkMode(false);
              setSelected(new Set());
            }}
          >
            <X />
          </Button>
        </div>
      )}

      {isAdmin ? (
        <ApiaryFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} selected{" "}
              {selected.size === 1 ? "apiary" : "apiaries"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Empty apiaries will be permanently removed. Any apiary that
              still contains a hive will be kept and reported.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDelete.isPending}
              onClick={(event) => {
                event.preventDefault();
                void deleteSelected();
              }}
            >
              {bulkDelete.isPending ? "Deleting…" : "Delete selected"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
