"use client";

/**
 * Varietals and the per-lot bulk balances they roll up. Bulk honey is one pool
 * split into labelled buckets: each harvest lot holds what it yielded minus
 * what has been jarred, used, or lost from it, and the unassigned residual is
 * what history left behind before lots were required.
 */

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnits } from "@/lib/use-units";

import { formatDate } from "./format";
import {
  useCreateVarietal,
  useHoneyLotBalances,
  useHoneyVarietals,
  useUpdateVarietal,
} from "./hooks";
import type { HoneyLotBalance, HoneyVarietal } from "./types";

// --- table model ---

const gridFeatures = tableFeatures({});
const varietalColumnHelper = createColumnHelper<
  typeof gridFeatures,
  HoneyVarietal
>();
const lotColumnHelper = createColumnHelper<typeof gridFeatures, HoneyLotBalance>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

/**
 * Sparse per-row edit drafts: a field is stored only once the user has typed
 * in it, so an untouched cell always shows the server value and a saved row
 * drops its draft to re-sync.
 */
interface VarietalDraft {
  name?: string;
  notes?: string;
}

// --- page ---

export function VarietalsView() {
  const varietals = useHoneyVarietals();
  const balances = useHoneyLotBalances();
  const { formatHoney } = useUnits();
  const createVarietal = useCreateVarietal();
  const updateVarietal = useUpdateVarietal();
  const { mutateAsync: createAsync } = createVarietal;
  const { mutateAsync: updateAsync } = updateVarietal;

  const [drafts, setDrafts] = React.useState<Record<string, VarietalDraft>>({});
  /** Which row's mutation is in flight, so other rows stay enabled. */
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState("");
  const [newNotes, setNewNotes] = React.useState("");

  const setDraft = React.useCallback((id: string, patch: VarietalDraft) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const saveVarietal = React.useCallback(
    async (varietal: HoneyVarietal, name: string, notes: string) => {
      if (name.trim() === "") {
        toast.error("Name is required");
        return;
      }
      setPendingId(varietal.id);
      try {
        await updateAsync({
          id: varietal.id,
          name: name.trim(),
          notes: notes.trim(),
        });
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[varietal.id];
          return next;
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not save the varietal",
        );
      } finally {
        setPendingId(null);
      }
    },
    [updateAsync],
  );

  const addVarietal = React.useCallback(async () => {
    if (newName.trim() === "") {
      toast.error("Name is required");
      return;
    }
    try {
      await createAsync({
        name: newName.trim(),
        notes: newNotes.trim() || undefined,
      });
      setNewName("");
      setNewNotes("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add the varietal",
      );
    }
  }, [createAsync, newName, newNotes]);

  const varietalRows = React.useMemo(
    () => varietals.data ?? [],
    [varietals.data],
  );
  const lotRows = React.useMemo(
    () => balances.data?.lots ?? [],
    [balances.data],
  );

  const varietalColumns = React.useMemo(
    () =>
      varietalColumnHelper.columns([
        varietalColumnHelper.display({
          id: "name",
          header: "Varietal",
          cell: ({ row: { original: varietal } }) => (
            <DataGridCellAction>
              <Input
                aria-label={`Name for ${varietal.name}`}
                className="w-48"
                value={drafts[varietal.id]?.name ?? varietal.name}
                onChange={(e) => setDraft(varietal.id, { name: e.target.value })}
              />
            </DataGridCellAction>
          ),
        }),
        varietalColumnHelper.display({
          id: "notes",
          header: "Notes",
          cell: ({ row: { original: varietal } }) => (
            <DataGridCellAction>
              <Input
                aria-label={`Notes for ${varietal.name}`}
                placeholder="Optional"
                value={drafts[varietal.id]?.notes ?? varietal.notes ?? ""}
                onChange={(e) => setDraft(varietal.id, { notes: e.target.value })}
              />
            </DataGridCellAction>
          ),
        }),
        varietalColumnHelper.display({
          id: "lotCount",
          header: "Lots",
          meta: rightAligned,
          cell: ({ row }) => row.original.lotCount,
        }),
        varietalColumnHelper.display({
          id: "onHand",
          header: "Bulk on hand",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.onHandLbs),
        }),
        varietalColumnHelper.display({
          id: "jarred",
          header: "Jarred",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.jarredLbs),
        }),
        varietalColumnHelper.display({
          id: "used",
          header: "Used",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.bulkUsedLbs),
        }),
        varietalColumnHelper.display({
          id: "lost",
          header: "Lost",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.lossLbs),
        }),
        varietalColumnHelper.display({
          id: "save",
          header: "",
          meta: {
            headClassName: "w-12",
            cellClassName: "p-1 text-right",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: varietal } }) => {
            const name = drafts[varietal.id]?.name ?? varietal.name;
            const notes = drafts[varietal.id]?.notes ?? varietal.notes ?? "";
            const dirty =
              name.trim() !== varietal.name ||
              notes.trim() !== (varietal.notes ?? "");
            return (
              <DataGridCellAction className="flex justify-end">
                <Button
                  size="icon-sm"
                  variant={dirty ? "default" : "ghost"}
                  aria-label={`Save ${varietal.name}`}
                  disabled={!dirty || pendingId === varietal.id}
                  onClick={() => saveVarietal(varietal, name, notes)}
                >
                  <Check />
                </Button>
              </DataGridCellAction>
            );
          },
        }),
      ]),
    [drafts, formatHoney, pendingId, saveVarietal, setDraft],
  );

  const lotColumns = React.useMemo(
    () =>
      lotColumnHelper.columns([
        lotColumnHelper.display({
          id: "lotCode",
          header: "Lot",
          cell: ({ row }) => (
            <span className="font-medium">{row.original.lotCode}</span>
          ),
        }),
        lotColumnHelper.display({
          id: "varietal",
          header: "Varietal",
          meta: {
            cellClassName: "text-sm text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) =>
            row.original.varietalName ?? row.original.honeyVariety ?? "—",
        }),
        lotColumnHelper.display({
          id: "extractionDate",
          header: "Extracted",
          meta: {
            cellClassName: "text-sm text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatDate(row.original.extractionDate),
        }),
        lotColumnHelper.display({
          id: "lotLbs",
          header: "Harvested",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.lotLbs),
        }),
        lotColumnHelper.display({
          id: "jarred",
          header: "Jarred",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.jarredLbs),
        }),
        lotColumnHelper.display({
          id: "used",
          header: "Used",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.bulkUsedLbs),
        }),
        lotColumnHelper.display({
          id: "lost",
          header: "Lost",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.lossLbs),
        }),
        lotColumnHelper.display({
          id: "onHand",
          header: "Bulk on hand",
          meta: {
            align: "right",
            cellClassName: "tabular-nums font-medium",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatHoney(row.original.onHandLbs),
        }),
      ]),
    [formatHoney],
  );

  const varietalTable = useTable({
    features: gridFeatures,
    columns: varietalColumns,
    data: varietalRows,
    getRowId: (row) => row.id,
  });

  const lotTable = useTable({
    features: gridFeatures,
    columns: lotColumns,
    data: lotRows,
    getRowId: (row) => row.lotId,
  });

  const unassigned = balances.data?.unassigned;
  const totals = balances.data?.totals;

  return (
    <div className="grid gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">
          Varietals &amp; lot balances
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every bulk draw names the lot it came out of, so each lot carries its
          own balance and the varietal is the rollup across them.
        </p>
      </header>

      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-base">Varietals</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {varietals.isPending ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <DataGrid
              table={varietalTable}
              aria-label="Honey varietals"
              trailingRows={
                <tr>
                  <td className="whitespace-nowrap p-3 align-middle">
                    <Input
                      aria-label="New varietal name"
                      className="w-48"
                      placeholder="New varietal…"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </td>
                  <td className="whitespace-nowrap p-3 align-middle">
                    <Input
                      aria-label="New varietal notes"
                      placeholder="Optional notes"
                      value={newNotes}
                      onChange={(e) => setNewNotes(e.target.value)}
                    />
                  </td>
                  <td className="whitespace-nowrap p-3 align-middle" />
                  <td className="whitespace-nowrap p-3 align-middle" />
                  <td className="whitespace-nowrap p-3 align-middle" />
                  <td className="whitespace-nowrap p-3 align-middle" />
                  <td className="whitespace-nowrap p-3 align-middle" />
                  <td className="whitespace-nowrap p-1 text-right align-middle">
                    <Button
                      size="icon-sm"
                      aria-label="Add varietal"
                      disabled={createVarietal.isPending || newName.trim() === ""}
                      onClick={addVarietal}
                    >
                      <Plus />
                    </Button>
                  </td>
                </tr>
              }
            />
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-base">Bulk honey by lot</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-0">
          {balances.isPending ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <DataGrid
                table={lotTable}
                aria-label="Bulk honey by lot"
                listenOnWindow={false}
              />
              {unassigned ? (
                <div className="mx-4 mb-4 rounded-md border border-dashed p-3 text-sm">
                  <p className="font-medium">
                    Unassigned · {formatHoney(unassigned.lbs)} bulk on hand
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Harvested honey no lot claims, less{" "}
                    {formatHoney(unassigned.drawnLbs)} drawn before lots were
                    required. Only history lands here now — every new draw names
                    a lot.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {totals ? (
        <p className="text-sm text-muted-foreground">
          {formatHoney(totals.totalHarvestedLbs)} harvested ·{" "}
          {formatHoney(totals.jarredLbs)} jarred ·{" "}
          {formatHoney(totals.bulkUsedLbs)} used ·{" "}
          {formatHoney(totals.lossLbs)} lost ·{" "}
          <span className="font-medium text-foreground">
            {formatHoney(totals.bulkOnHandLbs)} bulk on hand
          </span>
        </p>
      ) : null}
    </div>
  );
}
