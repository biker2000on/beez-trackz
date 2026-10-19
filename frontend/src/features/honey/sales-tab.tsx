"use client";

/**
 * Orders & register: every sale plus every jar that left at $0 — given away
 * or kept for your own use — newest first, from GET /sales/register.
 *
 * A give-away row is never revenue: it reads $0.00 with the jar count and a
 * muted "≈ $X retail" (the jars at each size's default price, value given).
 * The register's revenue total counts sales only. Which rows show is a URL
 * filter (?show=sales | ?show=giveaways), so a reload keeps it.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createColumnHelper,
  useTable,
} from "@tanstack/react-table";
import { Ban, Check, FileText, PackageCheck, Pencil, Undo2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { SaleDetailsDialog } from "@/features/commerce/sale-details-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, OfflineQueuedError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

import { formatDate, formatMoney } from "./format";
import { useDeleteSale, useReverseGiveAway, useSalesRegister } from "./hooks";
import { provenanceBody } from "@/lib/provenance";
import type {
  HoneySale,
  RegisterGiveAway,
  SalesRegisterEntry,
  SalesRegisterKind,
} from "./types";

const gridFeatures = dataGridFeatures;
const columnHelper = createColumnHelper<typeof gridFeatures, SalesRegisterEntry>();

const FILTERS: { value: SalesRegisterKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "sales", label: "Sales" },
  { value: "giveaways", label: "Given away & own use" },
];

function parseKind(raw: string | null): SalesRegisterKind {
  return raw === "sales" || raw === "giveaways" ? raw : "all";
}

/** A cancelled sale or an undone give-away keeps its row, dimmed. */
function isDimmed(entry: SalesRegisterEntry): boolean {
  return entry.type === "sale"
    ? entry.sale.orderStatus === "cancelled"
    : entry.giveAway.reversed;
}

function Dim({
  entry,
  className,
  children,
}: {
  entry: SalesRegisterEntry;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(isDimmed(entry) && "opacity-60", className)}>
      {children}
    </div>
  );
}

function giveAwayLabel(giveAway: RegisterGiveAway): string {
  return giveAway.purpose === "own_use" ? "Own use" : "Given away";
}

function jarCount(n: number): string {
  return `${n} ${n === 1 ? "jar" : "jars"}`;
}

/** "≈ $24.00 retail" (a floor, "+", when some sizes have no default price). */
function retailText(giveAway: RegisterGiveAway): string | null {
  if (giveAway.retailValue <= 0 && giveAway.unpricedJars > 0) return null;
  return `≈ ${formatMoney(giveAway.retailValue)}${giveAway.unpricedJars > 0 ? "+" : ""} retail`;
}

export function SalesTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const kind = parseKind(searchParams.get("show"));
  const register = useSalesRegister(kind);
  const deleteSale = useDeleteSale();
  const reverseGiveAway = useReverseGiveAway();
  const client = useQueryClient();
  const updateSale = useMutation({
    mutationFn: ({ id, orderStatus, amountPaid, paymentMethod }: { id: string; orderStatus: string; amountPaid: number; paymentMethod?: string }) =>
      orderStatus === "paid"
        ? api.post(`/sales/${id}/payment`, { amountPaidCents: Math.round(amountPaid * 100), paymentMethod })
        : api.post(`/sales/${id}/fulfill`, {}),
    onSuccess: () => {
      toast.success("Order updated");
      for (const key of ["honey", "commerce", "workbench", "stock", "stock-locations"])
        void client.invalidateQueries({ queryKey: [key] });
    },
    onError: (error) => {
      if (error instanceof OfflineQueuedError) {
        toast.info("Saved offline — will sync when you reconnect");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Could not update this order");
    },
  });
  const [confirmSale, setConfirmSale] = React.useState<HoneySale | null>(null);
  const [confirmUndo, setConfirmUndo] = React.useState<RegisterGiveAway | null>(null);
  const [editSale, setEditSale] = React.useState<HoneySale | null>(null);

  const setKind = React.useCallback(
    (next: SalesRegisterKind) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "all") params.delete("show");
      else params.set("show", next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  const data = React.useMemo(() => register.data?.entries ?? [], [register.data]);

  const updateSaleMutate = updateSale.mutate;
  const updateSalePending = updateSale.isPending;

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((r) => r.date, {
          id: "date",
          header: "Date",
          meta: { cellClassName: "align-top" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => (
            <Dim entry={entry}>{formatDate(entry.date)}</Dim>
          ),
        }),
        columnHelper.display({
          id: "items",
          header: "Items",
          meta: {
            cellClassName: "whitespace-normal align-top",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            if (entry.type !== "sale") {
              const giveAway = entry.giveAway;
              const notes =
                giveAway.notes && giveAway.notes !== giveAway.recipient
                  ? provenanceBody(giveAway.notes)
                  : null;
              return (
                <Dim entry={entry}>
                  <ul className="grid gap-0.5">
                    {giveAway.lines.map((line) => (
                      <li
                        key={`${giveAway.id}-${line.jarSizeId}-${line.harvestLotId ?? ""}`}
                        className={cn("text-sm", giveAway.reversed && "line-through")}
                      >
                        {line.quantity} × {line.label}
                        {(line.lotCode || line.varietal) && (
                          <span className="block text-xs text-muted-foreground">
                            {[line.lotCode && `Lot ${line.lotCode}`, line.varietal]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {notes && (
                    <p className="mt-1 text-xs text-muted-foreground">{notes}</p>
                  )}
                </Dim>
              );
            }
            const sale = entry.sale;
            return (
              <Dim entry={entry}>
                {sale.lineItems.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="grid gap-0.5">
                    {sale.lineItems.map((item) => (
                      <li
                        key={`${item.saleId}-${item.kind}-${item.jarSizeId ?? item.hiveId ?? item.itemId ?? item.productId}-${item.bottlingRunId ?? ""}`}
                        className="text-sm"
                      >
                        {item.quantity} × {item.label}
                        {item.kind && item.kind !== "jar" && (
                          <span className="ml-1 text-xs capitalize text-muted-foreground">
                            ({item.kind})
                          </span>
                        )}
                        <span className="ml-1 text-xs text-muted-foreground">
                          @ {formatMoney(item.unitPrice)}
                        </span>
                        {item.lotCode && (
                          <span className="block text-xs text-muted-foreground">
                            Lot {item.lotCode}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {provenanceBody(sale.notes) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {provenanceBody(sale.notes)}
                  </p>
                )}
              </Dim>
            );
          },
        }),
        columnHelper.accessor((r) => (r.type === "sale" ? (r.sale.location ?? "") : ""), {
          id: "location",
          header: "Location",
          meta: {
            cellClassName: "align-top text-muted-foreground",
            filter: true,
            filterAllLabel: "All locations",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => (
            <Dim entry={entry}>
              {entry.type === "sale" ? (entry.sale.location ?? "—") : "—"}
            </Dim>
          ),
        }),
        columnHelper.accessor(
          (r) => (r.type === "sale" ? (r.sale.customerName ?? "") : (r.giveAway.recipient ?? "")),
          {
            id: "customer",
            header: "Customer / recipient",
            meta: {
              cellClassName: "align-top text-muted-foreground",
            } satisfies DataGridColumnMeta,
            cell: ({ row: { original: entry } }) => (
              <Dim entry={entry}>
                {entry.type === "sale"
                  ? (entry.sale.customerName ?? "—")
                  : (entry.giveAway.recipient ?? "—")}
              </Dim>
            ),
          },
        ),
        columnHelper.accessor((r) => (r.type === "sale" ? (r.sale.orderNumber ?? "") : ""), {
          id: "order",
          header: "Order",
          meta: { cellClassName: "align-top" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            if (entry.type !== "sale") {
              const giveAway = entry.giveAway;
              return (
                <Dim entry={entry}>
                  <p className="text-sm text-muted-foreground">—</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge
                      variant={giveAway.purpose === "own_use" ? "outline" : "secondary"}
                      data-testid="register-zero-badge"
                    >
                      {giveAwayLabel(giveAway)}
                    </Badge>
                    {giveAway.reversed && <Badge variant="outline">Undone</Badge>}
                  </div>
                </Dim>
              );
            }
            const sale = entry.sale;
            return (
              <Dim entry={entry}>
                <p className="text-sm">{sale.orderNumber ?? "—"}</p>
                {sale.harvestLotCode && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Lot {sale.harvestLotCode}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="outline" className="capitalize">
                    {sale.channel.replaceAll("_", " ")}
                  </Badge>
                  <Badge
                    variant={
                      sale.orderStatus === "cancelled"
                        ? "outline"
                        : sale.amountPaid >= sale.totalAmount
                          ? "accent"
                          : "secondary"
                    }
                    className="capitalize"
                  >
                    {sale.orderStatus === "cancelled" ? "Cancelled" : sale.physicalAppliedAt ? "Fulfilled" : "Awaiting fulfillment"}
                  </Badge>
                  <Badge variant="outline">{sale.amountPaid >= sale.totalAmount ? "Paid" : sale.amountPaid > 0 ? "Partially paid" : "Unpaid"}</Badge>
                </div>
                {sale.orderStatus !== "cancelled" &&
                  sale.amountPaid < sale.totalAmount && (
                    <p className="mt-1 text-xs text-destructive">
                      {formatMoney(sale.totalAmount - sale.amountPaid)} due
                    </p>
                  )}
              </Dim>
            );
          },
        }),
        columnHelper.accessor((r) => (r.type === "sale" ? r.sale.totalAmount : 0), {
          id: "total",
          header: "Total (invoiced)",
          meta: {
            align: "right",
            cellClassName: "align-top font-medium tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            if (entry.type === "sale") {
              return <Dim entry={entry}>{formatMoney(entry.sale.totalAmount)}</Dim>;
            }
            const retail = retailText(entry.giveAway);
            return (
              <Dim entry={entry}>
                {formatMoney(0)}
                <p className="text-xs font-normal text-muted-foreground">
                  {jarCount(entry.giveAway.totalJars)}
                  {retail ? ` · ${retail}` : ""}
                </p>
              </Dim>
            );
          },
        }),
        columnHelper.display({
          id: "actions",
          header: "",
          meta: {
            cellClassName: "align-top p-1 text-right",
            card: "actions",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            if (entry.type !== "sale") {
              const giveAway = entry.giveAway;
              if (giveAway.reversed) return null;
              return (
                <DataGridCellAction className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={giveAway.purpose === "own_use" ? "Undo own use" : "Undo give-away"}
                    title="Undo — put the jars back"
                    onClick={() => setConfirmUndo(giveAway)}
                  >
                    <Undo2 className="size-4" />
                  </Button>
                </DataGridCellAction>
              );
            }
            const sale = entry.sale;
            return (
              <DataGridCellAction
                className={cn(
                  "flex justify-end",
                  sale.orderStatus === "cancelled" && "opacity-60",
                )}
              >
                {sale.orderStatus !== "cancelled" &&
                  sale.amountPaid < sale.totalAmount && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Mark order paid"
                      disabled={updateSalePending}
                      onClick={() =>
                        updateSaleMutate({
                          id: sale.id,
                          orderStatus: "paid",
                          amountPaid: sale.totalAmount,
                          paymentMethod: sale.paymentMethod,
                        })
                      }
                    >
                      <Check className="size-4" />
                    </Button>
                  )}
                {sale.orderStatus !== "cancelled" &&
                  !sale.physicalAppliedAt && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Mark order fulfilled"
                      disabled={updateSalePending}
                      onClick={() =>
                        updateSaleMutate({
                          id: sale.id,
                          orderStatus: "fulfilled",
                          amountPaid: sale.totalAmount,
                        })
                      }
                    >
                      <PackageCheck className="size-4" />
                    </Button>
                  )}
                {sale.orderStatus !== "cancelled" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Edit sale details"
                    title="Edit details"
                    onClick={() => setEditSale(sale)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open receipt or invoice"
                  asChild
                >
                  <Link href={`/sales/${sale.id}`}>
                    <FileText className="size-4" />
                  </Link>
                </Button>
                {sale.orderStatus !== "cancelled" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Cancel sale"
                    onClick={() => setConfirmSale(sale)}
                  >
                    <Ban className="size-4" />
                  </Button>
                )}
              </DataGridCellAction>
            );
          },
        }),
      ]),
    [updateSaleMutate, updateSalePending],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (entry) => `${entry.type}:${entry.id}`,
  });

  const filterBar = (
    <div
      role="group"
      aria-label="Show"
      className="flex flex-wrap gap-1"
    >
      {FILTERS.map((filter) => (
        <Button
          key={filter.value}
          type="button"
          size="sm"
          variant={kind === filter.value ? "default" : "outline"}
          aria-pressed={kind === filter.value}
          className="min-h-11 sm:min-h-9"
          onClick={() => setKind(filter.value)}
        >
          {filter.label}
        </Button>
      ))}
    </div>
  );

  let body: React.ReactNode;
  if (register.isPending) {
    body = <Skeleton className="h-48 w-full" />;
  } else if (register.isError) {
    body = (
      <div className="grid justify-items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {register.error instanceof ApiError && register.error.status === 403
            ? "Administrator access required"
            : "Could not load sales."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/stock">Open Stock</Link>
          </Button>
          <Button type="button" size="sm" onClick={() => void register.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  } else if (data.length === 0) {
    body = (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {kind === "giveaways" ? (
          "No jars given away or kept for own use yet."
        ) : (
          <>
            No sales recorded yet. Press{" "}
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">s</kbd>{" "}
            to record one.
          </>
        )}
      </p>
    );
  } else {
    body = (
      <div className="rounded-lg border">
        <DataGrid
          table={table}
          aria-label="Honey sales"
          onRowActivate={(entry) => {
            if (entry.type === "sale") router.push(`/sales/${entry.sale.id}`);
          }}
          onRowDelete={(entry) => {
            if (entry.type === "sale") {
              if (entry.sale.orderStatus !== "cancelled") setConfirmSale(entry.sale);
            } else if (!entry.giveAway.reversed) {
              setConfirmUndo(entry.giveAway);
            }
          }}
        />
      </div>
    );
  }

  const totals = register.data?.totals;
  const zeroJars = totals ? totals.givenAwayJars + totals.ownUseJars : 0;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {filterBar}
        {totals && (
          <p
            className="text-xs text-muted-foreground tabular-nums"
            data-testid="register-totals"
          >
            {totals.salesCount} {totals.salesCount === 1 ? "sale" : "sales"} ·{" "}
            <span className="font-medium text-foreground">
              {formatMoney(totals.revenue)} revenue
            </span>
            {zeroJars > 0 && (
              <>
                {" "}· {jarCount(totals.givenAwayJars)} given away
                {totals.ownUseJars > 0 && `, ${totals.ownUseJars} own use`}{" "}
                (≈ {formatMoney(totals.retailValueGiven)} retail, not revenue)
              </>
            )}
          </p>
        )}
      </div>
      {body}

      <SaleDetailsDialog
        sale={editSale}
        open={editSale !== null}
        onOpenChange={(open) => {
          if (!open) setEditSale(null);
        }}
      />

      <AlertDialog
        open={confirmSale !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmSale(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this sale?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmSale
                ? `The ${formatMoney(confirmSale.totalAmount)} sale from ${formatDate(confirmSale.date)} will be marked cancelled. Jars, colonies, feeders, and equipment this sale moved are restored. The record is kept for the ledger.`
                : ""}{" "}
              A cancelled sale cannot be reopened.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep sale</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmSale) deleteSale.mutate(confirmSale.id);
                setConfirmSale(null);
              }}
            >
              Cancel sale
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmUndo !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmUndo(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmUndo?.purpose === "own_use" ? "Undo this own use?" : "Undo this give-away?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmUndo
                ? `${jarCount(confirmUndo.totalJars)} from ${formatDate(confirmUndo.date)}${confirmUndo.recipient ? ` (${confirmUndo.recipient})` : ""} go back on the shelf at home.`
                : ""}{" "}
              The row stays in the register marked undone; the ledger keeps both
              entries.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmUndo) reverseGiveAway.mutate(confirmUndo.id);
                setConfirmUndo(null);
              }}
            >
              Undo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
