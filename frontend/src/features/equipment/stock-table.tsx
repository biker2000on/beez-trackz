"use client";

/**
 * Equipment stock grouped by category, showing owned / deployed / available /
 * needed / damaged / retired per type.
 *
 * The old bulk-edit mode is gone. In its place is a physical count (`c`): you
 * type what is actually on the shelf, the server works out each signed delta
 * and records it as a `physical_count` ledger entry, and any line it cannot
 * resolve comes back as an error against that row rather than being skipped.
 */

import * as React from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
          stockId: row.id,
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

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: rows.filter((row) => row.typeCategory === category),
  })).filter((group) => group.items.length > 0);

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
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Equipment</TableHead>
                <TableHead className="text-right">Owned</TableHead>
                <TableHead className="text-right">In field</TableHead>
                <TableHead className="text-right">
                  {countMode ? "Counted" : "Available"}
                </TableHead>
                <TableHead className="text-right">Needed</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Retired</TableHead>
                <TableHead>Location</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <React.Fragment key={group.category}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableCell
                      colSpan={9}
                      className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {CATEGORY_LABELS[group.category]}
                    </TableCell>
                  </TableRow>
                  {group.items.map((row) => {
                    const draft = drafts[row.id] ?? "";
                    const draftValue = parseNum(draft);
                    const changed =
                      countMode &&
                      draftValue != null &&
                      draftValue !== row.available;
                    const lineError = lineErrors[row.id];
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">
                          {row.typeName}
                          {row.frameCondition && (
                            <Badge
                              variant="secondary"
                              className="ml-2 capitalize"
                            >
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
                          {lineError && (
                            <p className="text-xs text-destructive">
                              {lineError}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.totalOwned}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.deployed}
                        </TableCell>
                        <TableCell className="text-right">
                          {countMode ? (
                            <Input
                              type="number"
                              inputMode="numeric"
                              step={1}
                              min={0}
                              aria-label={`${row.typeName} counted in storage`}
                              className={cn(
                                "ml-auto h-8 w-20 bg-background text-right",
                                changed && "border-primary ring-1 ring-primary",
                                lineError &&
                                  "border-destructive ring-1 ring-destructive",
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
                            <span
                              className={cn(
                                "font-semibold tabular-nums",
                                row.available < 0 && "text-destructive",
                              )}
                            >
                              {row.available}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.needed === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : row.shortfall > 0 ? (
                            <Badge variant="destructive">
                              {row.needed} · {row.shortfall} short
                            </Badge>
                          ) : (
                            row.needed
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.damaged === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Badge variant="secondary">{row.damaged}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.retired === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Badge variant="secondary">{row.retired}</Badge>
                          )}
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
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "receive" })
                                }
                              >
                                <PackagePlus className="size-4" />
                                Receive
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={row.available < 1}
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "deploy" })
                                }
                              >
                                <Truck className="size-4" />
                                Deploy to hive
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={row.available < 1}
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "damage" })
                                }
                              >
                                <Wrench className="size-4" />
                                Mark damaged
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={row.damaged < 1}
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "repair" })
                                }
                              >
                                <Wrench className="size-4" />
                                Back in service
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={row.available < 1 && row.damaged < 1}
                                onSelect={() =>
                                  setActive({ stock: row, dialog: "retire" })
                                }
                              >
                                <SquarePen className="size-4" />
                                Retire
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
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
                                  setActive({ stock: row, dialog: "details" })
                                }
                              >
                                <SquarePen className="size-4" />
                                Location, needed &amp; cost
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
