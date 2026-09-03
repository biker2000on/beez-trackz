"use client";

/**
 * Equipment stock grouped by category, showing owned / deployed / available /
 * needed / damaged / retired per type. Rendered as a DataGrid: arrow keys (or
 * j/k) move the focused row, Enter opens the row's edit dialog, and clicking
 * a row does the same.
 *
 * The old bulk-edit mode is gone. In its place is a physical count (`c`): you
 * type what is actually on the shelf, the server works out each signed delta
 * and records it as a `physical_count` ledger entry, and any line it cannot
 * resolve comes back as an error against that row rather than being skipped.
 */

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  ClipboardCheck,
  History,
  MoreHorizontal,
  PackagePlus,
  SlidersHorizontal,
  SquarePen,
  Truck,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useShortcut } from "@/components/shortcuts/provider";
import { apiLineErrors } from "@/lib/api";
import { cn } from "@/lib/utils";

import { parseNum, todayISO } from "./format";
import { usePhysicalCount } from "./hooks";
import {
  AdjustStockDialog,
  DeployDialog,
  EditDetailsDialog,
  HistoryDialog,
  ReceiveDialog,
  StateChangeDialog,
  type StateDialogMode,
} from "./stock-dialogs";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type EquipmentCategory,
  type EquipmentStockRow,
} from "./types";

type RowDialog =
  | "deploy"
  | "receive"
  | "adjust"
  | "details"
  | "history"
  | StateDialogMode;

const STATE_DIALOGS: StateDialogMode[] = ["damage", "repair", "retire"];

const gridFeatures = tableFeatures({});
const columnHelper = createColumnHelper<
  typeof gridFeatures,
  EquipmentStockRow
>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

export function StockTable({ rows }: { rows: EquipmentStockRow[] }) {
  const physicalCount = usePhysicalCount();

  const [countMode, setCountMode] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState("");
  const [lineErrors, setLineErrors] = React.useState<Record<string, string>>({});
  const [active, setActive] = React.useState<{
    stock: EquipmentStockRow;
    dialog: RowDialog;
  } | null>(null);

  const toggleCountMode = React.useCallback(() => {
    setCountMode((mode) => {
      if (!mode) {
        // Start from what the books claim so an unchanged row means "verified".
        setDrafts(
          Object.fromEntries(rows.map((row) => [row.id, String(row.available)])),
        );
        setNotes("");
        setLineErrors({});
      }
      return !mode;
    });
  }, [rows]);

  useShortcut("c", "Physical count", toggleCountMode);

  const countedRows = rows.filter((row) => {
    const draft = drafts[row.id];
    if (draft === undefined) return false;
    const value = parseNum(draft);
    return value != null && Number.isInteger(value) && value >= 0;
  });
  const changedCount = countedRows.filter(
    (row) => parseNum(drafts[row.id]) !== row.available,
  ).length;
  const invalidDrafts = rows.filter((row) => {
    const draft = drafts[row.id];
    if (draft === undefined || draft.trim() === "") return false;
    const value = parseNum(draft);
    return value == null || !Number.isInteger(value) || value < 0;
  });

  function submitCount() {
    if (countedRows.length === 0 || invalidDrafts.length > 0) return;
    setLineErrors({});
    physicalCount.mutate(
      {
        // Send the user's local calendar date; the server-side now() fallback
        // would stamp the count with the server-timezone day instead.
        date: todayISO(),
        notes: notes.trim() || undefined,
        lines: countedRows.map((row) => ({
          itemId: row.id,
          countedQuantity: parseNum(drafts[row.id])!,
        })),
      },
      {
        onSuccess: () => {
          setCountMode(false);
          setDrafts({});
          setLineErrors({});
        },
        onError: (error) => {
          const details = apiLineErrors(error);
          if (details.length === 0) return;
          const mapped: Record<string, string> = {};
          for (const detail of details) {
            const row = countedRows[detail.index];
            const key = detail.stockId ?? row?.id;
            if (key) mapped[key] = detail.message;
          }
          setLineErrors(mapped);
        },
      },
    );
  }

  const sortedRows = React.useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(a.typeCategory) -
            CATEGORY_ORDER.indexOf(b.typeCategory) ||
          a.typeName.localeCompare(b.typeName),
      ),
    [rows],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "equipment",
          header: "Equipment",
          meta: {
            cellClassName: "font-medium",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => (
            <>
              {row.typeName}
              {row.frameCondition && (
                <Badge variant="secondary" className="ml-2 capitalize">
                  {row.frameCondition}
                </Badge>
              )}
              {row.framesPerBox != null && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {row.framesPerBox} frames/box
                </span>
              )}
              {row.combAgeYears != null && (
                <span
                  className={cn(
                    "ml-2 text-xs",
                    row.pullRecommended
                      ? "font-semibold text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {row.pullRecommended
                    ? `This ${row.typeName.toLowerCase()} is ${row.combAgeYears} years old — pull it`
                    : `${row.combAgeYears} years in service`}
                </span>
              )}
              {lineErrors[row.id] && (
                <p className="text-xs text-destructive">{lineErrors[row.id]}</p>
              )}
            </>
          ),
        }),
        columnHelper.display({
          id: "owned",
          header: "Owned",
          meta: rightAligned,
          cell: ({ row }) => row.original.totalOwned,
        }),
        columnHelper.display({
          id: "deployed",
          header: "In field",
          meta: rightAligned,
          cell: ({ row }) => row.original.deployed,
        }),
        columnHelper.display({
          id: "available",
          header: countMode ? "Counted" : "Available",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => {
            if (!countMode) {
              return (
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    row.available < 0 && "text-destructive",
                  )}
                >
                  {row.available}
                </span>
              );
            }
            const draft = drafts[row.id] ?? "";
            const draftValue = parseNum(draft);
            const changed = draftValue != null && draftValue !== row.available;
            return (
              <DataGridCellAction>
                <Input
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={0}
                  aria-label={`${row.typeName} counted in storage`}
                  className={cn(
                    "ml-auto h-8 w-20 bg-background text-right",
                    changed && "border-primary ring-1 ring-primary",
                    lineErrors[row.id] &&
                      "border-destructive ring-1 ring-destructive",
                  )}
                  value={draft}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))
                  }
                />
              </DataGridCellAction>
            );
          },
        }),
        columnHelper.display({
          id: "needed",
          header: "Needed",
          meta: rightAligned,
          cell: ({ row: { original: row } }) =>
            row.needed === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : row.shortfall > 0 ? (
              <Badge variant="destructive">
                {row.needed} · {row.shortfall} short
              </Badge>
            ) : (
              row.needed
            ),
        }),
        columnHelper.display({
          id: "damaged",
          header: "Damaged",
          meta: rightAligned,
          cell: ({ row: { original: row } }) =>
            row.damaged === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <Badge variant="secondary">{row.damaged}</Badge>
            ),
        }),
        columnHelper.display({
          id: "retired",
          header: "Retired",
          meta: rightAligned,
          cell: ({ row: { original: row } }) =>
            row.retired === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <Badge variant="secondary">{row.retired}</Badge>
            ),
        }),
        columnHelper.display({
          id: "location",
          header: "Location",
          meta: {
            cellClassName: "max-w-40 truncate text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.storageLocation ?? "—",
        }),
        columnHelper.display({
          id: "actions",
          header: "",
          meta: {
            cellClassName: "p-1 text-right",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => (
            <DataGridCellAction className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${row.typeName} actions`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setActive({ stock: row, dialog: "receive" })}
                  >
                    <PackagePlus className="size-4" />
                    Receive
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={row.available < 1}
                    onSelect={() => setActive({ stock: row, dialog: "deploy" })}
                  >
                    <Truck className="size-4" />
                    Deploy to hive
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={row.available < 1}
                    onSelect={() => setActive({ stock: row, dialog: "damage" })}
                  >
                    <Wrench className="size-4" />
                    Mark damaged
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={row.damaged < 1}
                    onSelect={() => setActive({ stock: row, dialog: "repair" })}
                  >
                    <Wrench className="size-4" />
                    Back in service
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={row.available < 1 && row.damaged < 1}
                    onSelect={() => setActive({ stock: row, dialog: "retire" })}
                  >
                    <SquarePen className="size-4" />
                    Retire
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => setActive({ stock: row, dialog: "adjust" })}
                  >
                    <SlidersHorizontal className="size-4" />
                    Adjust count
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setActive({ stock: row, dialog: "details" })}
                  >
                    <SquarePen className="size-4" />
                    Location, needed &amp; cost
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setActive({ stock: row, dialog: "history" })}
                  >
                    <History className="size-4" />
                    History
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </DataGridCellAction>
          ),
        }),
      ]),
    [countMode, drafts, lineErrors],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: sortedRows,
    getRowId: (row) => row.id,
  });

  const errorMessage =
    physicalCount.isError && Object.keys(lineErrors).length === 0
      ? physicalCount.error instanceof Error
        ? physicalCount.error.message
        : "Count failed"
      : null;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Stock</h2>
        <Button
          type="button"
          variant={countMode ? "secondary" : "ghost"}
          size="sm"
          onClick={toggleCountMode}
        >
          <ClipboardCheck />
          {countMode ? "Cancel count" : "Physical count"}
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            c
          </kbd>
        </Button>
      </div>

      {countMode && (
        <div className="grid gap-2 rounded-lg border bg-muted/50 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Enter what you actually count in storage. Deployed, damaged, and
            retired equipment is not on the shelf, so leave it out — the
            difference is recorded as a dated count adjustment.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-64 bg-background"
              placeholder="Note (e.g. spring count)"
              aria-label="Count note"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={
                countedRows.length === 0 ||
                invalidDrafts.length > 0 ||
                physicalCount.isPending
              }
              onClick={submitCount}
            >
              {physicalCount.isPending
                ? "Saving…"
                : changedCount === 0
                  ? `Confirm ${countedRows.length} counted`
                  : `Save count · ${changedCount} to correct`}
            </Button>
            {invalidDrafts.length > 0 && (
              <span className="text-xs text-destructive">
                {invalidDrafts.length} row
                {invalidDrafts.length === 1 ? " has" : "s have"} an invalid count
              </span>
            )}
          </div>
          {errorMessage && (
            <p className="text-xs text-destructive">{errorMessage}</p>
          )}
          {Object.keys(lineErrors).length > 0 && (
            <p className="text-xs text-destructive">
              Nothing was saved. Fix the highlighted rows and submit again.
            </p>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          No equipment stock yet. Add stock to start tracking what you own.
        </p>
      ) : (
        <div className="rounded-lg border">
          <DataGrid
            table={table}
            aria-label="Equipment stock"
            getRowGroup={(row) => row.typeCategory}
            renderGroupHeader={(category) =>
              CATEGORY_LABELS[category as EquipmentCategory]
            }
            onRowActivate={(row) => setActive({ stock: row, dialog: "details" })}
          />
        </div>
      )}

      {active && (
        <>
          <DeployDialog
            stock={active.stock}
            open={active.dialog === "deploy"}
            onOpenChange={(open) => {
              if (!open) setActive(null);
            }}
          />
          <ReceiveDialog
            stock={active.stock}
            open={active.dialog === "receive"}
            onOpenChange={(open) => {
              if (!open) setActive(null);
            }}
          />
          <AdjustStockDialog
            stock={active.stock}
            open={active.dialog === "adjust"}
            onOpenChange={(open) => {
              if (!open) setActive(null);
            }}
          />
          {STATE_DIALOGS.includes(active.dialog as StateDialogMode) && (
            <StateChangeDialog
              stock={active.stock}
              mode={active.dialog as StateDialogMode}
              open
              onOpenChange={(open) => {
                if (!open) setActive(null);
              }}
            />
          )}
          <EditDetailsDialog
            stock={active.stock}
            open={active.dialog === "details"}
            onOpenChange={(open) => {
              if (!open) setActive(null);
            }}
          />
          <HistoryDialog
            stock={active.stock}
            open={active.dialog === "history"}
            onOpenChange={(open) => {
              if (!open) setActive(null);
            }}
          />
        </>
      )}
    </div>
  );
}
