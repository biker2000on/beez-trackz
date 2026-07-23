"use client";

/**
 * Equipment stock table grouped by category with a bulk-edit-counts mode
 * (`b`): inline owned-count inputs that highlight changes, a reason field,
 * and a single "Save N changes" action. Per-row actions open the deploy /
 * adjust / location / history dialogs.
 */

import * as React from "react";
import {
  History,
  ListChecks,
  MapPin,
  MoreHorizontal,
  SlidersHorizontal,
  Truck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useShortcut } from "@/components/shortcuts/provider";
import { cn } from "@/lib/utils";

import { parseNum } from "./format";
import { useBulkAdjustStock } from "./hooks";
import {
  AdjustStockDialog,
  DeployDialog,
  EditLocationDialog,
  HistoryDialog,
} from "./stock-dialogs";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type EquipmentStockRow,
} from "./types";

type RowDialog = "deploy" | "adjust" | "location" | "history";

export function StockTable({ rows }: { rows: EquipmentStockRow[] }) {
  const bulkAdjust = useBulkAdjustStock();

  const [bulkMode, setBulkMode] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [reason, setReason] = React.useState("");
  const [active, setActive] = React.useState<{
    stock: EquipmentStockRow;
    dialog: RowDialog;
  } | null>(null);

  const toggleBulkMode = React.useCallback(() => {
    setBulkMode((mode) => {
      if (!mode) {
        setDrafts(
          Object.fromEntries(rows.map((row) => [row.id, String(row.totalOwned)])),
        );
        setReason("");
      }
      return !mode;
    });
  }, [rows]);

  useShortcut("b", "Bulk-edit counts", toggleBulkMode);

  const changes = rows.filter((row) => {
    const draft = drafts[row.id];
    if (draft === undefined) return false;
    const value = parseNum(draft);
    return (
      value != null &&
      Number.isInteger(value) &&
      value >= 0 &&
      value !== row.totalOwned
    );
  });

  function saveBulk() {
    if (changes.length === 0) return;
    bulkAdjust.mutate(
      {
        reason: reason.trim() || undefined,
        lines: changes.map((row) => ({
          stockId: row.id,
          newTotal: parseNum(drafts[row.id])!,
        })),
      },
      {
        onSuccess: () => {
          setBulkMode(false);
          setDrafts({});
        },
      },
    );
  }

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: rows.filter((row) => row.typeCategory === category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Stock</h2>
        <Button
          type="button"
          variant={bulkMode ? "secondary" : "ghost"}
          size="sm"
          onClick={toggleBulkMode}
        >
          <ListChecks />
          {bulkMode ? "Cancel bulk edit" : "Bulk edit counts"}
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            b
          </kbd>
        </Button>
      </div>

      {bulkMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
          <Input
            className="h-8 max-w-64 bg-background"
            placeholder="Reason (e.g. yearly count)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={changes.length === 0 || bulkAdjust.isPending}
            onClick={saveBulk}
          >
            {bulkAdjust.isPending
              ? "Saving…"
              : `Save ${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          No equipment stock yet. Add stock to start tracking what you own.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Equipment</TableHead>
                <TableHead className="text-right">Owned</TableHead>
                <TableHead className="text-right">In field</TableHead>
                <TableHead className="text-right">In storage</TableHead>
                <TableHead>Location</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <React.Fragment key={group.category}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableCell
                      colSpan={6}
                      className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {CATEGORY_LABELS[group.category]}
                    </TableCell>
                  </TableRow>
                  {group.items.map((row) => {
                    const draft = drafts[row.id] ?? "";
                    const draftValue = parseNum(draft);
                    const changed =
                      bulkMode &&
                      draftValue != null &&
                      draftValue !== row.totalOwned;
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">
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
                        </TableCell>
                        <TableCell className="text-right">
                          {bulkMode ? (
                            <Input
                              type="number"
                              inputMode="numeric"
                              step={1}
                              min={0}
                              aria-label={`${row.typeName} owned count`}
                              className={cn(
                                "ml-auto h-8 w-20 bg-background text-right",
                                changed &&
                                  "border-primary ring-1 ring-primary",
                              )}
                              value={draft}
                              onChange={(e) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: e.target.value,
                                }))
                              }
                            />
                          ) : (
                            <span className="font-semibold tabular-nums">
                              {row.totalOwned}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.deployed}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums",
                            row.available < 0 && "text-destructive",
                          )}
                        >
                          {row.available}
                        </TableCell>
                        <TableCell className="max-w-40 truncate text-muted-foreground">
                          {row.storageLocation ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
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
                                disabled={row.available < 1}
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "deploy" })
                                }
                              >
                                <Truck className="size-4" />
                                Deploy to hive
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "adjust" })
                                }
                              >
                                <SlidersHorizontal className="size-4" />
                                Adjust count
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "location" })
                                }
                              >
                                <MapPin className="size-4" />
                                Edit location
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "history" })
                                }
                              >
                                <History className="size-4" />
                                History
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
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
          <AdjustStockDialog
            stock={active.stock}
            open={active.dialog === "adjust"}
            onOpenChange={(open) => {
              if (!open) setActive(null);
            }}
          />
          <EditLocationDialog
            stock={active.stock}
            open={active.dialog === "location"}
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
