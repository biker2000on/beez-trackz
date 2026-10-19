"use client";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccessProfile } from "@/features/access/api";
import {
  useProductionWorkbench,
  useSalesWorkbench,
} from "@/features/workbench/api";

/**
 * The operation-wide work below the hive cards on Today: open extractions,
 * pending orders, due settlements and jar sizes below target. Each row names
 * the area it belongs to with that area's nav label, never a word of its own.
 */
export function OperationWork() {
  const access = useAccessProfile();
  const admin = access.data?.isAdmin === true;
  const production = useProductionWorkbench(undefined, admin);
  const sales = useSalesWorkbench(undefined, admin);
  if (!admin) return null;
  const rows = [
    ...(production.data?.openSessions ?? []).map((s) => ({
      id: s.id,
      title: s.apiaryName ?? "Extraction session",
      reason: `${s.entryCount} harvest entries / extraction remains open`,
      href: `/production/sessions/${s.id}`,
      group: "Harvests",
    })),
    ...(sales.data?.drafts ?? []).map((s) => ({
      id: s.saleId,
      title: s.customerName ?? "Walk-in order",
      reason: s.shortfalls?.length
        ? "Stock shortage needs attention"
        : "Order awaiting fulfillment",
      href: `/sales/${s.saleId}`,
      group: "Orders",
    })),
    ...(sales.data?.consignment ?? [])
      .filter(
        (s) =>
          s.settlementDueAt &&
          new Date(s.settlementDueAt).getTime() <=
            new Date(sales.data?.asOf ?? 0).getTime(),
      )
      .map((s) => ({
        id: s.locationId,
        title: s.name,
        reason: "Consignment settlement is due",
        href: `/sales/consignment/${s.locationId}`,
        group: "Consignment",
      })),
    ...(production.data?.jarStock ?? [])
      .filter((s) => s.parLevel !== null && s.available < s.parLevel)
      .map((s) => ({
        id: s.jarSizeId,
        title: s.label,
        reason: `${s.available} available / below target ${s.parLevel}`,
        href: "/stock?tab=finished",
        group: "On hand",
      })),
  ];
  const loading =
    rows.length === 0 && (production.isPending || sales.isPending);
  return (
    <section className="mt-5" aria-label="Operation work">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Across the operation</h2>
        <div className="flex gap-3 text-sm">
          <Link className="underline" href="/production">
            In progress
          </Link>
          <Link className="underline" href="/sales">
            Sales
          </Link>
          <Link className="underline" href="/stock">
            Stock
          </Link>
        </div>
      </div>
      {production.isError || sales.isError ? (
        <p role="alert" className="mb-3 text-sm">
          Some operation work could not load.{" "}
          <button
            className="underline"
            onClick={() => {
              void production.refetch();
              void sales.refetch();
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
      {production.data?.freshness?.stale || sales.data?.freshness?.stale ? (
        <p className="mb-3 text-xs">
          Cached work: reconnect and refresh before acting.
        </p>
      ) : null}
      {loading ? (
        <div className="atlas-records" aria-busy>
          <div className="atlas-record grid gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <div className="atlas-record grid gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
      ) : (
        <div className="atlas-records">
          {rows.map((row) => (
            <Link
              key={`${row.group}-${row.id}`}
              href={row.href}
              className="atlas-record flex items-center justify-between gap-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div>
                <p className="font-medium">{row.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{row.reason}</p>
              </div>
              <span className="text-xs text-muted-foreground">{row.group} →</span>
            </Link>
          ))}
          {rows.length === 0 && (
            <p className="atlas-record text-sm text-muted-foreground">
              No open extractions, pending orders, due settlements, or jar stock below target.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
