"use client";

/**
 * Consignment: every place finished goods sit that is not home.
 *
 * The bike shop does not buy the stock up front — it sells on the operator's
 * behalf and pays as jars move. So this page shows two numbers per location
 * that a plain sales list cannot: how many units are standing on their shelf,
 * and how much they still owe for what has already sold.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Plus, Store, Warehouse } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/features/honey/format";
import { ApiError } from "@/lib/api";

import { useCustomers, useWholesalePriceLists } from "./api";
import {
  useCreateStockLocation,
  useStockLocations,
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
        ? `Wholesale · ${location.wholesalePriceListName}`
        : "Wholesale price list";
    default:
      return "Full retail remitted";
  }
}

export function ConsignmentPage() {
  const locations = useStockLocations();
  const [addOpen, setAddOpen] = React.useState(false);

  if (locations.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (locations.isError) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {locations.error instanceof ApiError && locations.error.status === 403
          ? "Administrator access required"
          : "Could not load stock locations."}
      </p>
    );
  }

  const home = locations.data.find((location) => location.isHome);
  const away = locations.data.filter((location) => !location.isHome);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Consignment</h1>
          <p className="text-sm text-muted-foreground">
            Stock that sits somewhere other than home. Sending jars out is a
            transfer, not a sale — nothing is earned until the shop reports.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
          <Plus />
          Add location
        </Button>
      </div>

      {home && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Warehouse className="size-4 text-primary" />
              Home
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-3xl font-bold tabular-nums">
              {home.onHandUnits}
            </span>
            <span className="text-sm text-muted-foreground">
              units available to sell at market day
            </span>
          </CardContent>
        </Card>
      )}

      {away.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No other locations yet. Add the bike shop to start tracking what is on
          their shelf.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {away.map((location) => (
            <LocationCard key={location.id} location={location} />
          ))}
        </div>
      )}

      <AddLocationDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function LocationCard({ location }: { location: StockLocation }) {
  return (
    <Card className={location.isActive ? undefined : "opacity-60"}>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Store className="size-4 text-primary" />
          <span className="min-w-0 truncate">{location.name}</span>
          {location.isConsignment && <Badge variant="accent">Consignment</Badge>}
          {!location.isActive && <Badge variant="outline">inactive</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="On their shelf" value={String(location.onHandUnits)} />
          <Stat
            label="Owed to you"
            value={formatMoney(location.outstandingBalance)}
            tone={location.outstandingBalance > 0 ? "due" : undefined}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {consignmentTerms(location)} · settles {location.settlementCadence.replaceAll("_", " ")}
          {location.customerName ? ` · ${location.customerName}` : ""}
        </p>
        <Button asChild variant="outline" size="sm" className="justify-self-start">
          <Link href={`/sales/consignment/${location.id}`}>
            Open
            <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "due";
}) {
  return (
    <div className="rounded-md bg-muted p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p
        className={
          tone === "due"
            ? "text-lg font-bold tabular-nums text-amber-700 dark:text-amber-400"
            : "text-lg font-bold tabular-nums"
        }
      >
        {value}
      </p>
    </div>
  );
}

function AddLocationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateStockLocation();
  const customers = useCustomers();
  const priceLists = useWholesalePriceLists();
  const [name, setName] = React.useState("");
  const [customerId, setCustomerId] = React.useState("none");
  const [priceBasis, setPriceBasis] = React.useState<StockPriceBasis>("commission");
  const [commission, setCommission] = React.useState("30");
  const [priceListId, setPriceListId] = React.useState("none");
  const [cadence, setCadence] = React.useState<StockSettlementCadence>("monthly");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) return;
    // Reset only on close, so a failed save keeps what was typed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName("");
     
    setNotes("");
  }, [open]);

  const commissionPercent = Number(commission);
  const valid =
    name.trim().length > 0 &&
    (priceBasis !== "commission" ||
      (Number.isFinite(commissionPercent) &&
        commissionPercent >= 0 &&
        commissionPercent <= 100)) &&
    (priceBasis !== "wholesale_list" || priceListId !== "none");

  function submit() {
    if (!valid) return;
    create.mutate(
      {
        name: name.trim(),
        isConsignment: true,
        customerId: customerId === "none" ? undefined : customerId,
        priceBasis,
        commissionPercent:
          priceBasis === "commission" ? commissionPercent : undefined,
        wholesalePriceListId:
          priceBasis === "wholesale_list" && priceListId !== "none"
            ? priceListId
            : undefined,
        settlementCadence: cadence,
        notes: notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a stock location</DialogTitle>
          <DialogDescription>
            Where finished goods sit when they are not at home. Linking a
            customer lets the settlement invoice them directly.
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
            <Label htmlFor="location-name">Name</Label>
            <Input
              id="location-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Bike shop"
            />
          </div>
          <div className="grid gap-1">
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not linked</SelectItem>
                {(customers.data ?? []).map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label>They are paid by</Label>
              <Select
                value={priceBasis}
                onValueChange={(value) => setPriceBasis(value as StockPriceBasis)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="commission">Commission %</SelectItem>
                  <SelectItem value="wholesale_list">Wholesale price list</SelectItem>
                  <SelectItem value="retail">Nothing (full retail to you)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {priceBasis === "commission" && (
              <div className="grid gap-1">
                <Label htmlFor="location-commission">Their cut (%)</Label>
                <Input
                  id="location-commission"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={commission}
                  onChange={(event) => setCommission(event.target.value)}
                />
              </div>
            )}
            {priceBasis === "wholesale_list" && (
              <div className="grid gap-1">
                <Label>Price list</Label>
                <Select value={priceListId} onValueChange={setPriceListId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Choose a list</SelectItem>
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
          <div className="grid gap-1">
            <Label>Settles</Label>
            <Select
              value={cadence}
              onValueChange={(value) =>
                setCadence(value as StockSettlementCadence)
              }
            >
              <SelectTrigger>
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
            <Label htmlFor="location-notes">Notes</Label>
            <Textarea
              id="location-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Who to hand jars to, shelf position, anything else."
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? "Saving…" : "Add location"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
