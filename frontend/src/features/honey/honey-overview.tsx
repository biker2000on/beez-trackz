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
import { ApiError } from "@/lib/api";

import { useUnits } from "@/lib/use-units";

import { formatDate, formatMoney } from "./format";
import {
  useHarvests,
  useHoneyOverview,
  useHoneySales,
  useHoneyTimeline,
} from "./hooks";
import { HoneyQuickActions } from "./quick-actions";

function honeyErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status === 403
    ? "Administrator access required"
    : fallback;
}

export function HoneyOverview() {
  const { formatHoney } = useUnits();
  const overview = useHoneyOverview();
  const sales = useHoneySales();
  const lowStock = useLowStock();
  const timeline = useHoneyTimeline(6);
  const harvests = useHarvests();

  const data = overview.data;
  const jarsOnHand = data?.inventory.reduce((sum, row) => sum + row.onHand, 0);

  // "Unpaid" is derived from fields the sales API already returns; no new
  // formula and no server change. Amount owed = invoiced minus collected.
  // Never treat a failed sales fetch as an empty list — that printed 0 / $0.00.
  const openOrders = (sales.data ?? []).filter(
    (sale) => sale.orderStatus !== "cancelled" && sale.amountPaid < sale.totalAmount,
  );
  const amountOwed = sales.isSuccess
    ? openOrders.reduce(
        (sum, sale) => sum + (sale.totalAmount - sale.amountPaid),
        0,
      )
    : 0;
  const unpaidCount = sales.isSuccess ? openOrders.length : 0;

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
          value={data ? formatHoney(data.bulkOnHandLbs) : undefined}
          sub={
            data
              ? data.bulkOnHandLbs < 0
                ? "Jars on the shelf exceed recorded harvests."
                : `${formatHoney(data.totalHarvestedLbs)} harvested to date`
              : undefined
          }
          tone={data && data.bulkOnHandLbs < 0 ? "danger" : "default"}
          loading={overview.isPending}
          error={
            overview.isError
              ? honeyErrorMessage(overview.error, "Could not load bulk stock.")
              : undefined
          }
          onRetry={overview.isError ? () => void overview.refetch() : undefined}
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
          error={
            overview.isError
              ? honeyErrorMessage(overview.error, "Could not load packaged stock.")
              : undefined
          }
          onRetry={overview.isError ? () => void overview.refetch() : undefined}
        />
        <StatCard
          icon={DollarSign}
          label="Unpaid orders"
          value={sales.isSuccess ? String(unpaidCount) : undefined}
          sub={
            sales.isSuccess
              ? `${formatMoney(amountOwed)} invoiced, not collected`
              : undefined
          }
          loading={sales.isPending}
          error={
            sales.isError
              ? honeyErrorMessage(sales.error, "Could not load unpaid orders.")
              : undefined
          }
          onRetry={sales.isError ? () => void sales.refetch() : undefined}
        />
      </div>

      <NextActions
        bulkOnHandLbs={data?.bulkOnHandLbs ?? 0}
        lowStock={lowStock.data ?? []}
        openOrderCount={unpaidCount}
        amountOwed={amountOwed}
        degraded={overview.isError || sales.isError}
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
            ) : harvests.isError ? (
              <InlineError
                message={honeyErrorMessage(
                  harvests.error,
                  "Could not load harvests.",
                )}
                onRetry={() => void harvests.refetch()}
              />
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
                      {formatHoney(harvest.calculatedHoneyWeight)}
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
            ) : timeline.isError ? (
              <InlineError
                message={honeyErrorMessage(
                  timeline.error,
                  "Could not load recent activity.",
                )}
                onRetry={() => void timeline.refetch()}
              />
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
  degraded,
}: {
  bulkOnHandLbs: number;
  lowStock: { jarSizeId: string; label: string; onHand: number; threshold: number }[];
  openOrderCount: number;
  amountOwed: number;
  degraded: boolean;
}) {
  const { formatHoney } = useUnits();
  const prompts: { key: string; title: string; detail: string; href: string; cta: string }[] = [];

  if (bulkOnHandLbs < 0) {
    prompts.push({
      key: "bulk-short",
      title: "Bulk honey is short of what was jarred",
      detail: `${formatHoney(Math.abs(bulkOnHandLbs))} more has been jarred than harvested. Record the missing harvests or write off the gap.`,
      href: "/harvest/harvests",
      cta: "Record harvests",
    });
  } else if (bulkOnHandLbs > 0) {
    prompts.push({
      key: "bottle",
      title: `${formatHoney(bulkOnHandLbs)} awaiting bottling`,
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
      href: "/sales",
      cta: "Open sales",
    });
  }

  if (prompts.length === 0) {
    // A failed overview/sales fetch must not be reported as "nothing to do".
    if (degraded) return null;
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
  error,
  onRetry,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  sub?: string;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  tone?: "default" | "danger";
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
        {error ? (
          <div className="mt-2 grid gap-2">
            <p className="text-sm text-muted-foreground">{error}</p>
            {onRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : loading || value == null ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p
            className={
              tone === "danger"
                ? "mt-1 truncate text-2xl font-bold tabular-nums text-destructive"
                : "mt-1 truncate text-2xl font-bold tabular-nums"
            }
          >
            {value}
          </p>
        )}
        {sub != null && !loading && !error && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}

function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
