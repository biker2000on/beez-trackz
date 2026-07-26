"use client";

import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatMoney } from "@/features/honey/format";
import type { HoneySale } from "@/features/honey/types";
import { api } from "@/lib/api";

interface Receipt {
  seller: string;
  sale: HoneySale;
  balanceDue: number;
  documentType: "receipt" | "invoice";
}

export function ReceiptView({ saleId }: { saleId: string }) {
  const receipt = useQuery({
    queryKey: ["commerce", "receipt", saleId],
    queryFn: () => api.get<Receipt>(`/honey/sales/${saleId}/receipt`),
  });
  if (receipt.isPending) {
    return <Skeleton className="mx-auto h-96 max-w-2xl" />;
  }
  if (receipt.isError) {
    return <p className="text-sm text-muted-foreground">Could not load this receipt.</p>;
  }
  const { sale } = receipt.data;
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <div className="flex justify-end print:hidden">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>
      <Card className="print:border-0 print:shadow-none">
        <CardHeader className="border-b">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">
            {receipt.data.documentType}
          </p>
          <CardTitle className="flex items-start justify-between gap-4">
            <span>{receipt.data.seller}</span>
            <span className="text-right text-base font-medium">{sale.orderNumber}</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {formatDate(sale.date)} · {sale.channel.replaceAll("_", " ")}
          </p>
        </CardHeader>
        <CardContent className="grid gap-6 p-6">
          {sale.customerName && (
            <div>
              <p className="text-xs uppercase text-muted-foreground">Bill to</p>
              <p className="font-medium">{sale.customerName}</p>
            </div>
          )}
          {sale.harvestLotCode && (
            <div>
              <p className="text-xs uppercase text-muted-foreground">Honey lot</p>
              <p className="font-medium">{sale.harvestLotCode}</p>
            </div>
          )}
          <div className="grid gap-2">
            {sale.lineItems.map((item) => (
              <div
                key={item.jarSizeId}
                className="grid grid-cols-[1fr_auto_auto] gap-4 border-b py-2 text-sm"
              >
                <span>{item.label}</span>
                <span>{item.quantity} × {formatMoney(item.unitPrice)}</span>
                <span className="font-medium">
                  {formatMoney(item.quantity * item.unitPrice)}
                </span>
              </div>
            ))}
          </div>
          <div className="ml-auto grid w-full max-w-xs gap-2 text-sm">
            {sale.discountAmount > 0 && (
              <div className="flex justify-between">
                <span>Discount</span>
                <span>−{formatMoney(sale.discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-lg font-bold">
              <span>Total</span><span>{formatMoney(sale.totalAmount)}</span>
            </div>
            <div className="flex justify-between">
              <span>Paid by {sale.paymentMethod}</span>
              <span>{formatMoney(sale.amountPaid)}</span>
            </div>
            {receipt.data.balanceDue > 0 && (
              <div className="flex justify-between font-semibold text-destructive">
                <span>Balance due</span>
                <span>{formatMoney(receipt.data.balanceDue)}</span>
              </div>
            )}
          </div>
          {sale.notes && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {sale.notes}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
