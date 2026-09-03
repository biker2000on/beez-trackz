"use client";

/** Sales tab: sales table with line items and per-sale cancellation. */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Ban, Check, FileText, PackageCheck } from "lucide-react";

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
} from "@/components/ui/data-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import { formatDate, formatMoney } from "./format";
import { useDeleteSale, useHoneySales, useUpdateSale } from "./hooks";
import type { HoneySale } from "./types";

const gridFeatures = tableFeatures({});
const columnHelper = createColumnHelper<typeof gridFeatures, HoneySale>();

/** A cancelled sale keeps its row but reads as struck from the record. */
function Dim({
  sale,
  className,
  children,
}: {
  sale: HoneySale;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(sale.orderStatus === "cancelled" && "opacity-60", className)}
    >
      {children}
    </div>
  );
}

export function SalesTab() {
  const router = useRouter();
  const sales = useHoneySales();
  const deleteSale = useDeleteSale();
  const updateSale = useUpdateSale();
  const [confirmSale, setConfirmSale] = React.useState<HoneySale | null>(null);

  const data = React.useMemo(() => sales.data ?? [], [sales.data]);

  const updateSaleMutate = updateSale.mutate;
  const updateSalePending = updateSale.isPending;

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "date",
          header: "Date",
          meta: { cellClassName: "align-top" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
            <Dim sale={sale}>{formatDate(sale.date)}</Dim>
          ),
        }),
        columnHelper.display({
          id: "items",
          header: "Items",
          meta: {
            cellClassName: "whitespace-normal align-top",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
            <Dim sale={sale}>
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
              {sale.notes && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {sale.notes}
                </p>
              )}
            </Dim>
          ),
        }),
        columnHelper.display({
          id: "location",
          header: "Location",
          meta: {
            cellClassName: "align-top text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
            <Dim sale={sale}>{sale.location ?? "—"}</Dim>
          ),
        }),
        columnHelper.display({
          id: "customer",
          header: "Customer",
          meta: {
            cellClassName: "align-top text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
            <Dim sale={sale}>{sale.customerName ?? "—"}</Dim>
          ),
        }),
        columnHelper.display({
          id: "order",
          header: "Order",
          meta: { cellClassName: "align-top" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
            <Dim sale={sale}>
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
                  {sale.orderStatus}
                </Badge>
              </div>
              {sale.orderStatus !== "cancelled" &&
                sale.amountPaid < sale.totalAmount && (
                  <p className="mt-1 text-xs text-destructive">
                    {formatMoney(sale.totalAmount - sale.amountPaid)} due
                  </p>
                )}
            </Dim>
          ),
        }),
        columnHelper.display({
          id: "total",
          header: "Total (invoiced)",
          meta: {
            align: "right",
            cellClassName: "align-top font-medium tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
            <Dim sale={sale}>{formatMoney(sale.totalAmount)}</Dim>
          ),
        }),
        columnHelper.display({
          id: "actions",
          header: "",
          meta: {
            cellClassName: "align-top p-1 text-right",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: sale } }) => (
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
                sale.amountPaid >= sale.totalAmount &&
                sale.orderStatus !== "fulfilled" && (
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
              <Button type="button" variant="ghost" size="icon-sm" asChild>
                <Link
                  href={`/sales/${sale.id}`}
                  aria-label="Open receipt or invoice"
                >
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
          ),
        }),
      ]),
    [updateSaleMutate, updateSalePending],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (sale) => sale.id,
  });

  if (sales.isPending) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (sales.isError) {
    return (
      <div className="grid justify-items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {sales.error instanceof ApiError && sales.error.status === 403
            ? "Administrator access required"
            : "Could not load sales."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/production">Back to Honey</Link>
          </Button>
          <Button type="button" size="sm" onClick={() => void sales.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (sales.data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No sales recorded yet. Press <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">s</kbd> to record one.
      </p>
    );
  }

  return (
    <div className="rounded-lg border">
      <DataGrid
        table={table}
        aria-label="Honey sales"
        onRowActivate={(sale) => router.push(`/sales/${sale.id}`)}
        onRowDelete={(sale) => {
          if (sale.orderStatus !== "cancelled") setConfirmSale(sale);
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
    </div>
  );
}
