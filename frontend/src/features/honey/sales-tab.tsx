"use client";

/** Sales tab: sales table with line items and per-sale delete. */

import * as React from "react";
import Link from "next/link";
import { Check, FileText, PackageCheck, Trash2 } from "lucide-react";

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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { formatDate, formatMoney } from "./format";
import { useDeleteSale, useHoneySales, useUpdateSale } from "./hooks";
import type { HoneySale } from "./types";

export function SalesTab() {
  const sales = useHoneySales();
  const deleteSale = useDeleteSale();
  const updateSale = useUpdateSale();
  const [confirmSale, setConfirmSale] = React.useState<HoneySale | null>(null);

  if (sales.isPending) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (sales.isError) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Could not load sales.
      </p>
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Order</TableHead>
            <TableHead className="text-right">Total (invoiced)</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sales.data.map((sale) => (
            <TableRow key={sale.id}>
              <TableCell className="align-top">
                {formatDate(sale.date)}
              </TableCell>
              <TableCell className="whitespace-normal align-top">
                {sale.lineItems.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="grid gap-0.5">
                    {sale.lineItems.map((item) => (
                      <li
                        key={`${item.saleId}-${item.jarSizeId}`}
                        className="text-sm"
                      >
                        {item.quantity} × {item.label}
                        <span className="ml-1 text-xs text-muted-foreground">
                          @ {formatMoney(item.unitPrice)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {sale.notes && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sale.notes}
                  </p>
                )}
              </TableCell>
              <TableCell className="align-top text-muted-foreground">
                {sale.location ?? "—"}
              </TableCell>
              <TableCell className="align-top text-muted-foreground">
                {sale.customerName ?? "—"}
              </TableCell>
              <TableCell className="align-top">
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
                    variant={sale.amountPaid >= sale.totalAmount ? "accent" : "secondary"}
                    className="capitalize"
                  >
                    {sale.orderStatus}
                  </Badge>
                </div>
                {sale.amountPaid < sale.totalAmount && (
                  <p className="mt-1 text-xs text-destructive">
                    {formatMoney(sale.totalAmount - sale.amountPaid)} due
                  </p>
                )}
              </TableCell>
              <TableCell className="align-top text-right font-medium tabular-nums">
                {formatMoney(sale.totalAmount)}
              </TableCell>
              <TableCell className="align-top text-right">
                {sale.amountPaid < sale.totalAmount && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Mark order paid"
                    disabled={updateSale.isPending}
                    onClick={() =>
                      updateSale.mutate({
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
                {sale.amountPaid >= sale.totalAmount && sale.orderStatus !== "fulfilled" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Mark order fulfilled"
                    disabled={updateSale.isPending}
                    onClick={() =>
                      updateSale.mutate({
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
                    href={`/harvest/sales/${sale.id}`}
                    aria-label="Open receipt or invoice"
                  >
                    <FileText className="size-4" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Delete sale"
                  onClick={() => setConfirmSale(sale)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog
        open={confirmSale !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmSale(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this sale?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmSale
                ? `The ${formatMoney(confirmSale.totalAmount)} sale from ${formatDate(confirmSale.date)} and its line items will be removed, returning the jars to inventory.`
                : ""}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmSale) deleteSale.mutate(confirmSale.id);
                setConfirmSale(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
