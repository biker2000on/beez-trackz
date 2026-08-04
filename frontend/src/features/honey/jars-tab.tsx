"use client";

/** Jars tab: derived jar inventory table per size. */

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
import { cn } from "@/lib/utils";

import { formatMoney } from "./format";
import { useJarInventory } from "./hooks";

export function JarsTab() {
  const inventory = useJarInventory();

  if (inventory.isPending) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (inventory.isError) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Could not load jar inventory.
      </p>
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

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Size</TableHead>
            <TableHead className="text-right">On hand</TableHead>
            <TableHead className="text-right">Jarred</TableHead>
            <TableHead className="text-right">Sold</TableHead>
            <TableHead className="text-right">Given</TableHead>
            <TableHead className="text-right">Adjusted</TableHead>
            <TableHead className="text-right">Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
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
                  row.onHand < 0 && "text-destructive",
                )}
              >
                {row.onHand}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.jarred}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.sold}
              </TableCell>
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
