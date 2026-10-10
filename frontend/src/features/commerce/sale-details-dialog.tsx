"use client";

/**
 * Edit who a recorded sale was to, and the context written on it, after the
 * fact (PATCH /sales/{id}/details). Shared by the receipt page and the sales
 * list's row action.
 *
 * Only what changed is sent, so a notes-only edit never rewrites the customer
 * (and never re-queues the sale for Folio). Amounts, lines, stock and status
 * are not editable here and the API refuses to touch them.
 *
 * A consignment settlement sale belongs to the store it settled: its customer
 * and location follow the store, so only its notes are editable.
 */

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { customerDisplayName, useCustomers } from "@/features/commerce/api";
import {
  type SaleDetailsPatch,
  useSaleLocations,
  useUpdateSaleDetails,
} from "@/features/honey/hooks";
import type { HoneySale } from "@/features/honey/types";
import { OfflineQueuedError } from "@/lib/api";

const WALK_IN = "__walk_in__";

/** A consignment settlement: the store's sale, tied to its linked customer. */
export function isConsignmentSettlementSale(sale: Pick<HoneySale, "channel" | "stockLocationId">) {
  return sale.channel === "consignment" && sale.stockLocationId != null;
}

/** The PATCH body for what changed between the sale and the form, or null. */
export function saleDetailsPatch(
  sale: Pick<HoneySale, "customerId" | "customerName" | "location" | "notes">,
  form: { customer: string; walkInName: string; location: string; notes: string },
): SaleDetailsPatch | null {
  const patch: SaleDetailsPatch = {};
  const initialCustomer = sale.customerId ?? WALK_IN;
  const initialWalkIn = sale.customerId ? "" : (sale.customerName ?? "").trim();
  const walkIn = form.walkInName.trim();
  if (
    form.customer !== initialCustomer ||
    (form.customer === WALK_IN && walkIn !== initialWalkIn)
  ) {
    if (form.customer === WALK_IN) {
      patch.customerId = null;
      patch.customerName = walkIn || null;
    } else {
      // The API stores the saved customer's company (else name) on the sale.
      patch.customerId = form.customer;
      patch.customerName = null;
    }
  }
  const location = form.location.trim();
  if (location !== (sale.location ?? "").trim()) patch.location = location || null;
  const notes = form.notes.trim();
  if (notes !== (sale.notes ?? "").trim()) patch.notes = notes || null;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function SaleDetailsDialog({
  sale,
  open,
  onOpenChange,
}: {
  sale: HoneySale | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open && sale != null} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-lg">
        {sale && (
          // Keyed so reopening for another sale starts from that sale.
          <SaleDetailsForm key={sale.id} sale={sale} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SaleDetailsForm({ sale, onDone }: { sale: HoneySale; onDone: () => void }) {
  const customers = useCustomers();
  const locations = useSaleLocations();
  const mutation = useUpdateSaleDetails();
  const locked = isConsignmentSettlementSale(sale);

  const [customer, setCustomer] = React.useState(sale.customerId ?? WALK_IN);
  const [walkInName, setWalkInName] = React.useState(
    sale.customerId ? "" : (sale.customerName ?? ""),
  );
  const [location, setLocation] = React.useState(sale.location ?? "");
  const [notes, setNotes] = React.useState(sale.notes ?? "");

  const options = customers.data ?? [];
  // The sale's own customer stays choosable while the list loads.
  const missingCurrent =
    sale.customerId != null && !options.some((option) => option.id === sale.customerId);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const patch = saleDetailsPatch(sale, { customer, walkInName, location, notes });
    if (!patch) {
      onDone();
      return;
    }
    mutation.mutate(
      { id: sale.id, ...patch },
      {
        onSuccess: onDone,
        onError: (error) => {
          if (error instanceof OfflineQueuedError) onDone();
        },
      },
    );
  };

  const apiError =
    mutation.error && !(mutation.error instanceof OfflineQueuedError)
      ? mutation.error instanceof Error
        ? mutation.error.message
        : "Could not save these details"
      : null;

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Edit sale details</DialogTitle>
        <DialogDescription>
          {sale.orderNumber ?? "This sale"} · who it was to and the context on it.
          Amounts, items and stock are not changed.
        </DialogDescription>
      </DialogHeader>

      {locked && (
        <p className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">
          This is a consignment settlement: its customer and location follow the
          store it was settled with. Only the notes can be edited here.
        </p>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="sale-details-customer">Customer</Label>
        <Select value={customer} onValueChange={setCustomer} disabled={locked}>
          <SelectTrigger id="sale-details-customer" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WALK_IN}>No saved customer / walk-in name</SelectItem>
            {missingCurrent && (
              <SelectItem value={sale.customerId!}>
                {sale.customerName ?? "Current customer"}
              </SelectItem>
            )}
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {customerDisplayName(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {customer === WALK_IN && (
          <Input
            id="sale-details-walk-in"
            aria-label="Walk-in name"
            placeholder="Name for the receipt (optional)"
            value={walkInName}
            disabled={locked}
            onChange={(event) => setWalkInName(event.target.value)}
          />
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="sale-details-location">Location</Label>
        <Input
          id="sale-details-location"
          list="sale-details-locations"
          placeholder="e.g. Farmers market"
          value={location}
          disabled={locked}
          onChange={(event) => setLocation(event.target.value)}
        />
        <datalist id="sale-details-locations">
          {(locations.data ?? []).map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="sale-details-notes">Notes</Label>
        <Textarea
          id="sale-details-notes"
          rows={3}
          placeholder="Context for this sale"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      {apiError && (
        <p role="alert" className="text-sm text-destructive">
          {apiError}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save details"}
        </Button>
      </DialogFooter>
    </form>
  );
}
