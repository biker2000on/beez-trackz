"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HoneySale } from "@/features/honey/types";
export function OrderActions({ sale }: { sale: HoneySale }) {
  const client = useQueryClient();
  const [payment, setPayment] = useState(String(sale.amountPaid));
  const [confirm, setConfirm] = useState(false);
  const [receipt, setReceipt] = useState("");
  const command = useMutation({
    mutationFn: async (kind: "payment" | "fulfill") => {
      const amount = Number(payment);
      if (kind === "payment" && (!Number.isFinite(amount) || amount < 0))
        throw new Error("Enter a valid payment total.");
      await api.post(
        `/sales/${sale.id}/${kind}`,
        kind === "payment"
          ? {
              amountPaidCents: Math.round(amount * 100),
              paymentMethod: sale.paymentMethod,
            }
          : {},
      );
      return kind;
    },
    onSuccess: (kind) => {
      setReceipt(
        kind === "payment"
          ? "Payment saved. Fulfillment is unchanged."
          : "Order fulfilled. Stock movement saved; payment is unchanged.",
      );
      setConfirm(false);
      for (const key of ["commerce", "honey", "stock", "workbench"])
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
  if (sale.orderStatus === "cancelled")
    return <p className="text-sm">This order is cancelled.</p>;
  return (
    <section className="atlas-records print:hidden">
      <div className="atlas-record">
        <h2 className="font-semibold">Payment & fulfillment</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {sale.physicalAppliedAt ? "Fulfilled" : "Awaiting fulfillment"} /{" "}
          {sale.amountPaid >= sale.totalAmount
            ? "Paid"
            : sale.amountPaid > 0
              ? "Partially paid"
              : "Unpaid"}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs">
            Total collected to date
            <Input
              inputMode="decimal"
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={command.isPending}
            onClick={() => command.mutate("payment")}
          >
            Save payment
          </Button>
          {!sale.physicalAppliedAt && (
            <Button
              disabled={command.isPending}
              onClick={() => setConfirm(true)}
            >
              Fulfill order
            </Button>
          )}
        </div>
        {confirm && (
          <div className="mt-3 rounded-md border p-3">
            <p className="mb-3 text-sm">
              Fulfill all {sale.lineItems.length} order lines from their
              selected stock location. This records physical delivery and leaves
              the payment amount unchanged.
            </p>
            <Button
              disabled={command.isPending}
              onClick={() => command.mutate("fulfill")}
            >
              Confirm fulfillment
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        )}
        {command.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {command.error.message}
          </p>
        )}
        {receipt && (
          <p role="status" className="mt-3 text-sm">
            {receipt}
          </p>
        )}
      </div>
    </section>
  );
}
