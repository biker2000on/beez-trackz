"use client";

/**
 * Jars tab: derived jar inventory per size.
 *
 * On hand is split by where the jars actually are. "At home" is what can be
 * sold at market day; anything consigned to a shop is still the operator's
 * stock and still counts toward the total, but it is not on the table. Showing
 * one merged number was how the same jar got sold twice.
 */

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useStockInventory,
  type StockInventory,
} from "@/features/commerce/stock-locations-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import { formatMoney } from "./format";
import { useJarInventory } from "./hooks";

/**
 * Per-jar-size counts keyed by location, plus the away locations that actually
 * hold something. Away columns only appear once stock is really out there, so
 * an operator with one location sees the table they have always seen.
 */
function splitByLocation(inventory: StockInventory | undefined) {
  const locations = inventory?.locations ?? [];
  const home = locations.find((location) => location.isHome);
  const away = locations.filter(
    (location) =>
      !location.isHome &&
      (inventory?.items ?? []).some((item) => (item.byLocation[location.id] ?? 0) !== 0),
  );
  const byJarSize = new Map<string, Record<string, number>>();
  for (const item of inventory?.items ?? []) {
    if (item.jarSizeId) byJarSize.set(item.jarSizeId, item.byLocation);
  }
  return { homeId: home?.id, away, byJarSize };
}

export function JarsTab() {
  const inventory = useJarInventory();
  const locations = useStockInventory();

  if (inventory.isPending) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (inventory.isError) {
    return (
      <TabLoadError
        message={
          inventory.error instanceof ApiError && inventory.error.status === 403
            ? "Administrator access required"
            : "Could not load jar inventory."
        }
        onRetry={() => void inventory.refetch()}
      />
    );
  }
  const rows = inventory.data;
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No jar sizes configured. Add sizes in Settings first.
      </p>
    );
  }

  const { homeId, away, byJarSize } = splitByLocation(locations.data);

  return (
    <div className="grid gap-3">
      <div className="rounded-lg border">
        {/* Sits on the page background, not a card, so the pinned column has to
            match that surface. */}
        <Table pinFirstColumn className="[--table-pin-bg:var(--background)]">
          <TableHeader>
            <TableRow>
              <TableHead>Size</TableHead>
              <TableHead className="text-right">At home</TableHead>
              {away.map((location) => (
                <TableHead key={location.id} className="text-right">
                  {location.name}
                </TableHead>
              ))}
              {away.length > 0 && <TableHead className="text-right">Total</TableHead>}
              <TableHead className="text-right">Jarred</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Given</TableHead>
              <TableHead className="text-right">Adjusted</TableHead>
              <TableHead className="text-right">Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const perLocation = byJarSize.get(row.jarSizeId) ?? {};
              // Fall back to the global figure while the locations request is
              // still in flight, rather than flashing a zero.
              const atHome = homeId ? (perLocation[homeId] ?? 0) : row.onHand;
              return (
                <TableRow
                  key={row.jarSizeId}
                  className={row.isActive === false ? "opacity-60" : undefined}
                >
                  <TableCell className="font-medium">
                    {row.label}
                    {row.honeyOz != null && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {row.honeyOz} oz
                      </span>
                    )}
                    {row.isActive === false && (
                      <Badge variant="outline" className="ml-2 text-muted-foreground">
                        inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-semibold tabular-nums",
                      atHome < 0 && "text-destructive",
                    )}
                  >
                    {atHome}
                  </TableCell>
                  {away.map((location) => (
                    <TableCell
                      key={location.id}
                      className="text-right tabular-nums text-muted-foreground"
                    >
                      {perLocation[location.id] ?? 0}
                    </TableCell>
                  ))}
                  {away.length > 0 && (
                    <TableCell
                      className={cn(
                        "text-right font-semibold tabular-nums",
                        row.onHand < 0 && "text-destructive",
                      )}
                    >
                      {row.onHand}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">{row.jarred}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.sold}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.givenAway}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.adjusted > 0 ? `+${row.adjusted}` : row.adjusted}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.defaultPrice != null ? formatMoney(row.defaultPrice) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {away.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Jars at another location are still yours, but market day can only sell
          what is at home.{" "}
          <Link className="underline underline-offset-2" href="/sales/consignment">
            Manage consignment
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function TabLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid justify-items-center gap-3 py-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/harvest">Back to Honey</Link>
        </Button>
        <Button type="button" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
