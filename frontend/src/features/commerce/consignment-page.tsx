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
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/features/honey/format";
import { ApiError } from "@/lib/api";

import { consignmentTerms, StockLocationDialog } from "./stock-location-form";
import { useStockLocations, type StockLocation } from "./stock-locations-api";

// Kept here so existing imports of the terms helper keep working.
export { consignmentTerms };

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

      <StockLocationDialog open={addOpen} onOpenChange={setAddOpen} />
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
