"use client";

import Link from "next/link";
import { Droplet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useHoneyOverview } from "./hooks";
import { WidgetFrame } from "./widget-frame";

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

export function HoneySummaryWidget() {
  const overview = useHoneyOverview();
  const data = overview.data;
  const jarsOnHand =
    data?.inventory.reduce((sum, row) => sum + row.onHand, 0) ?? 0;

  return (
    <WidgetFrame
      title="Honey inventory"
      icon={Droplet}
      isLoading={overview.isPending}
      isError={overview.isError}
      action={
        <Link
          href="/harvest"
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Honey
        </Link>
      }
    >
      <div className="grid gap-3">
        <dl className="grid grid-cols-3 gap-2 text-center">
          <div>
            <dt className="text-xs text-muted-foreground">Bulk lbs</dt>
            <dd className="text-lg font-semibold">
              {(data?.bulkOnHandLbs ?? 0).toFixed(1)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Jars</dt>
            <dd className="text-lg font-semibold">{jarsOnHand}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Revenue</dt>
            <dd className="text-lg font-semibold">
              {currency.format(data?.totalRevenue ?? 0)}
            </dd>
          </div>
        </dl>
        {(data?.inventory.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {data?.inventory.map((row) => (
              <Badge key={row.jarSizeId} variant="secondary">
                {row.label}: {row.onHand}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </WidgetFrame>
  );
}
