"use client";

/**
 * One form for a stock location's terms, used to add a location and to edit
 * one. Editing replaces the whole location (the PATCH endpoint refuses a
 * partial body), so the edit form is prefilled with every field and sends
 * every field back, including the ones it does not show as changed.
 */

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Textarea } from "@/components/ui/textarea";

import { customerDisplayName, useCustomers, useWholesalePriceLists } from "./api";
import {
  useCreateStockLocation,
  useUpdateStockLocation,
  type StockLocation,
  type StockPriceBasis,
  type StockSettlementCadence,
} from "./stock-locations-api";

/** Plain-English terms, so the card says what the shop actually keeps. */
export function consignmentTerms(location: StockLocation): string {
  switch (location.priceBasis) {
    case "commission":
      return `${((location.commissionBps ?? 0) / 100).toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })}% commission`;
    case "wholesale_list":
      return location.wholesalePriceListName
        ? `Wholesale · your price per jar (from ${location.wholesalePriceListName})`
        : "Wholesale · your price per jar";
    default:
      return "Full retail remitted";
  }
}

const NONE = "none";

interface FormState {
  name: string;
  customerId: string;
  priceBasis: StockPriceBasis;
  commission: string;
  priceListId: string;
  cadence: StockSettlementCadence;
  address: string;
  notes: string;
  isActive: boolean;
}

function initialState(location: StockLocation | undefined): FormState {
  if (!location) {
    return {
      name: "",
      customerId: NONE,
      priceBasis: "commission",
      commission: "30",
      priceListId: NONE,
      cadence: "monthly",
      address: "",
      notes: "",
      isActive: true,
    };
  }
  return {
    name: location.name,
    customerId: location.customerId ?? NONE,
    priceBasis: location.priceBasis,
    commission:
      location.commissionBps != null ? String(location.commissionBps / 100) : "30",
    priceListId: location.wholesalePriceListId ?? NONE,
    cadence: location.settlementCadence,
    address: location.address ?? "",
    notes: location.notes ?? "",
    isActive: location.isActive,
  };
}

/**
 * Add a location (no `location`) or edit one's terms (`location` given).
 */
export function StockLocationDialog({
  open,
  onOpenChange,
  location,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location?: StockLocation;
}) {
  const editing = location != null;
  const create = useCreateStockLocation();
  const update = useUpdateStockLocation();
  const customers = useCustomers();
  const priceLists = useWholesalePriceLists();
  const [form, setForm] = React.useState<FormState>(() => initialState(location));

  React.useEffect(() => {
    // Editing: reload the saved terms each time the dialog opens. Adding:
    // reset only on close, so a failed save keeps what was typed.
    if (editing && open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(initialState(location));
    } else if (!editing && !open) {
      setForm(initialState(undefined));
    }
    // `location` is deliberately not a dependency: a background refetch must
    // not wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  function patch(next: Partial<FormState>) {
    setForm((current) => ({ ...current, ...next }));
  }

  const pending = create.isPending || update.isPending;
  const commissionPercent = Number(form.commission);
  const commissionValid =
    form.priceBasis !== "commission" ||
    (form.commission.trim() !== "" &&
      Number.isFinite(commissionPercent) &&
      commissionPercent >= 0 &&
      commissionPercent <= 100);
  const valid = form.name.trim().length > 0 && commissionValid;

  function submit() {
    if (!valid || pending) return;
    const commissionValue =
      form.priceBasis === "commission" ? commissionPercent : null;
    const priceListValue =
      form.priceBasis === "wholesale_list" && form.priceListId !== NONE
        ? form.priceListId
        : null;
    const done = { onSuccess: () => onOpenChange(false) };
    if (location) {
      update.mutate(
        {
          id: location.id,
          name: form.name.trim(),
          isConsignment: location.isConsignment,
          customerId: form.customerId === NONE ? null : form.customerId,
          priceBasis: form.priceBasis,
          commissionPercent: commissionValue,
          wholesalePriceListId: priceListValue,
          settlementCadence: form.cadence,
          address: form.address.trim() || null,
          notes: form.notes.trim() || null,
          isActive: form.isActive,
        },
        done,
      );
      return;
    }
    create.mutate(
      {
        name: form.name.trim(),
        isConsignment: true,
        customerId: form.customerId === NONE ? undefined : form.customerId,
        priceBasis: form.priceBasis,
        commissionPercent: commissionValue ?? undefined,
        wholesalePriceListId: priceListValue ?? undefined,
        settlementCadence: form.cadence,
        address: form.address.trim() || undefined,
        notes: form.notes.trim() || undefined,
      },
      done,
    );
  }

  const idPrefix = editing ? "edit-location" : "location";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit terms for ${location.name}` : "Add a stock location"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "How this store is paid and how often it settles. Changing terms affects future reports, not ones already recorded."
              : "Where finished goods sit when they are not at home. Linking a customer lets the settlement invoice them directly."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={submit}
        >
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-name`}>Name</Label>
            <Input
              id={`${idPrefix}-name`}
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Bike shop"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-customer`}>Customer</Label>
            <Select
              value={form.customerId}
              onValueChange={(value) => patch({ customerId: value })}
            >
              <SelectTrigger id={`${idPrefix}-customer`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not linked</SelectItem>
                {(customers.data ?? []).map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customerDisplayName(customer)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor={`${idPrefix}-basis`}>They are paid by</Label>
              <Select
                value={form.priceBasis}
                onValueChange={(value) =>
                  patch({ priceBasis: value as StockPriceBasis })
                }
              >
                <SelectTrigger id={`${idPrefix}-basis`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="commission">Commission %</SelectItem>
                  <SelectItem value="wholesale_list">
                    Wholesale — my price per jar
                  </SelectItem>
                  <SelectItem value="retail">Nothing (full retail to you)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.priceBasis === "commission" && (
              <div className="grid gap-1">
                <Label htmlFor={`${idPrefix}-commission`}>Their cut (%)</Label>
                <Input
                  id={`${idPrefix}-commission`}
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.commission}
                  onChange={(event) => patch({ commission: event.target.value })}
                />
                {!commissionValid && (
                  <p className="text-xs text-destructive">
                    Enter a percentage from 0 to 100.
                  </p>
                )}
              </div>
            )}
            {form.priceBasis === "wholesale_list" && (
              <div className="grid gap-1">
                <Label htmlFor={`${idPrefix}-price-list`}>
                  Start from price list (optional)
                </Label>
                <Select
                  value={form.priceListId}
                  onValueChange={(value) => patch({ priceListId: value })}
                >
                  <SelectTrigger id={`${idPrefix}-price-list`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No list — set prices per jar</SelectItem>
                    {(priceLists.data ?? []).map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {form.priceBasis === "wholesale_list" && (
            <p className="-mt-2 text-xs text-muted-foreground">
              You are owed your price for each jar they sell, whatever they
              charge. Set it per jar under Prices on the location page; the
              list, if chosen, fills in any jar you have not priced.
            </p>
          )}
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-cadence`}>Settles</Label>
            <Select
              value={form.cadence}
              onValueChange={(value) =>
                patch({ cadence: value as StockSettlementCadence })
              }
            >
              <SelectTrigger id={`${idPrefix}-cadence`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Every two weeks</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="on_request">On request</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-address`}>Address</Label>
            <Input
              id={`${idPrefix}-address`}
              value={form.address}
              onChange={(event) => patch({ address: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
            <Textarea
              id={`${idPrefix}-notes`}
              value={form.notes}
              onChange={(event) => patch({ notes: event.target.value })}
              placeholder="Who to hand jars to, shelf position, anything else."
            />
          </div>
          {editing && (
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${idPrefix}-active`}
                checked={form.isActive}
                onCheckedChange={(checked) => patch({ isActive: checked === true })}
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`${idPrefix}-active`}>Active</Label>
                <p className="text-xs text-muted-foreground">
                  Inactive locations stay in history but are greyed out on the
                  consignment page.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? "Saving…" : editing ? "Save terms" : "Add location"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
