"use client";

/**
 * Honey overview (`/harvest`): the default page for the Honey module.
 *
 * This replaces the old seven-tab hub. It carries operational numbers only —
 * what is on hand and what needs doing. Money lives in one place, `/reports`,
 * so the three surfaces that used to disagree cannot drift; the one financial
 * figure kept here (money owed on open orders) is explicitly labelled
 * *invoiced, not collected*.
 */

import Link from "next/link";
import {
  ArrowRight,
  ChartNoAxesCombined,
  DollarSign,
  Droplets,
  Package,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLowStock } from "@/features/commerce/api";

import { formatDate, formatLbs, formatMoney } from "./format";
import {
  useHarvests,
  useHoneyOverview,
  useHoneySales,
  useHoneyTimeline,
} from "./hooks";
import { HoneyQuickActions } from "./quick-actions";

export function HoneyOverview() {
  const overview = useHoneyOverview();
  const sales = useHoneySales();
  const lowStock = useLowStock();
  const timeline = useHoneyTimeline(6);
  const harvests = useHarvests();

  const data = overview.data;
  const jarsOnHand = data?.inventory.reduce((sum, row) => sum + row.onHand, 0);

  // "Unpaid" is derived from fields the sales API already returns; no new
  // formula and no server change. Amount owed = invoiced minus collected.
  const openOrders = (sales.data ?? []).filter(
    (sale) => sale.orderStatus !== "cancelled" && sale.amountPaid < sale.totalAmount,
  );
  const amountOwed = openOrders.reduce(
    (sum, sale) => sum + (sale.totalAmount - sale.amountPaid),
    0,
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Honey</h1>
          <p className="text-sm text-muted-foreground">
            Bulk and packaged stock, and what needs doing next.
          </p>
        </div>
        <HoneyQuickActions />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={Droplets}
          label="Bulk on hand"
          value={data ? formatLbs(data.bulkOnHandLbs) : undefined}
          sub={data ? `${formatLbs(data.totalHarvestedLbs)} harvested to date` : undefined}
          loading={overview.isPending}
        />
        <StatCard
          icon={Package}
          label="Packaged stock"
          value={jarsOnHand != null ? `${jarsOnHand} jars` : undefined}
          sub={
            data
              ? data.inventory
                  .filter((row) => row.onHand > 0)
                  .map((row) => `${row.onHand} ${row.label}`)
                  .join(" · ") || "None jarred"
              : undefined
          }
          loading={overview.isPending}
        />
        <StatCard
          icon={DollarSign}
          label="Unpaid orders"
          value={sales.isPending ? undefined : String(openOrders.length)}
          sub={
            sales.isPending
              ? undefined
              : `${formatMoney(amountOwed)} invoiced, not collected`
          }
          loading={sales.isPending}
        />
      </div>

      <NextActions
        bulkOnHandLbs={data?.bulkOnHandLbs ?? 0}
        lowStock={lowStock.data ?? []}
        openOrderCount={openOrders.length}
        amountOwed={amountOwed}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent harvests</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/harvest/harvests">
                All harvests
                <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {harvests.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : (harvests.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                No harvests recorded yet.
              </p>
            ) : (
              <ul className="grid gap-2">
                {harvests.data?.slice(0, 5).map((harvest) => (
                  <li
                    key={harvest.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {harvest.hiveName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {harvest.apiaryName} · {formatDate(harvest.date)}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatLbs(harvest.calculatedHoneyWeight)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent activity</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/harvest/activity">
                Full ledger
                <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {timeline.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : (timeline.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing recorded in the honey ledger yet.
              </p>
            ) : (
              <ul className="grid gap-2">
                {timeline.data?.slice(0, 5).map((entry) => (
                  <li
                    key={`${entry.type}-${entry.id}`}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {entry.description}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(entry.date)}
                      </span>
                    </span>
                    <Badge variant="outline" className="shrink-0 capitalize">
                      {entry.type.replaceAll("_", " ")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Revenue, expenses, profitability and bottling plans live in one
            place so the numbers cannot disagree.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/reports">
              <ChartNoAxesCombined />
              Open reports
            </Link>
          </Button>
        </CardContent>
      </Card>

    </div>
  );
}

function NextActions({
  bulkOnHandLbs,
  lowStock,
  openOrderCount,
  amountOwed,
}: {
  bulkOnHandLbs: number;
  lowStock: { jarSizeId: string; label: string; onHand: number; threshold: number }[];
  openOrderCount: number;
  amountOwed: number;
}) {
  const prompts: { key: string; title: string; detail: string; href: string; cta: string }[] = [];

  if (bulkOnHandLbs > 0) {
    prompts.push({
      key: "bottle",
      title: `${formatLbs(bulkOnHandLbs)} awaiting bottling`,
      detail: "Bulk honey is extracted but not yet in jars.",
      href: "/reports/bottling",
      cta: "See bottling plan",
    });
  }
  if (lowStock.length > 0) {
    prompts.push({
      key: "low-stock",
      title: `${lowStock.length} jar ${lowStock.length === 1 ? "size" : "sizes"} low on stock`,
      detail: lowStock
        .map((row) => `${row.label} ${row.onHand}/${row.threshold}`)
        .join(" · "),
      href: "/harvest/jars",
      cta: "Review jars",
    });
  }
  if (openOrderCount > 0) {
    prompts.push({
      key: "unpaid",
      title: `${openOrderCount} unpaid ${openOrderCount === 1 ? "order" : "orders"}`,
      detail: `${formatMoney(amountOwed)} invoiced and not yet collected.`,
      href: "/harvest/sales",
      cta: "Open sales",
    });
  }

  if (prompts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
        Nothing needs attention: no bulk awaiting bottling, no low stock, no
        unpaid orders.
      </div>
    );
  }

  return (
    <section className="grid gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Next actions
      </h2>
      <ul className="grid gap-2">
        {prompts.map((prompt) => (
          <li
            key={prompt.key}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"
          >
            <div className="min-w-0">
              <p className="font-medium">{prompt.title}</p>
              <p className="text-sm text-muted-foreground">{prompt.detail}</p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href={prompt.href}>
                {prompt.cta}
                <ArrowRight />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  sub?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-xs font-medium uppercase tracking-wide">
            {label}
          </span>
        </div>
        {loading || value == null ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p className="mt-1 truncate text-2xl font-bold tabular-nums">
            {value}
          </p>
        )}
        {sub != null && !loading && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}
