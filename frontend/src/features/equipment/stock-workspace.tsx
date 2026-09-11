"use client";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAccessProfile } from "@/features/access/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionNav } from "@/components/shell/section-nav";
import { NAV_ITEMS } from "@/components/shell/nav-items";
export interface StockRow {
  itemId: string;
  itemName: string;
  kind: string;
  unit: string;
  locationId: string | null;
  locationName: string | null;
  lotId: string | null;
  lotCode: string | null;
  harvestLotId: string | null;
  condition: string | null;
  hiveId: string | null;
  onHand: string;
  reserved: string;
  available: string;
  countKnown: boolean;
  originKnown: boolean;
  holds: { kind: string; reason: string; until: string | null }[];
  holdsKnown?: boolean;
}
interface StockRead {
  asOf: string;
  freshness: { stale: boolean; origin: string };
  rows: StockRow[];
  history?: {
    operationId: string;
    kind: string;
    reason: string;
    occurredAt: string;
    quantity: string;
    sourceType: string;
    sourceId: string;
    lotId: string | null;
    harvestLotId?: string | null;
    hiveId: string | null;
  }[];
}
const kinds: Record<string, string> = {
  equipment: "equipment",
  bulk: "bulk_honey",
  packaging: "packaging",
  finished: "jar",
};
function sourceHref(entry: NonNullable<StockRead["history"]>[number]) {
  const id = encodeURIComponent(entry.sourceId);
  if (entry.sourceType === "sale") return `/sales/${id}`;
  if (entry.sourceType === "hive") return `/yard/hives/${id}`;
  if (entry.sourceType === "harvest_lot") return `/production/lots/${id}`;
  if (entry.sourceType === "harvest_session")
    return `/production/sessions/${id}`;
  if (entry.sourceType === "product_batch")
    return `/production/products/batches/${id}`;
  if (entry.sourceType === "bottling_run" && entry.harvestLotId)
    return `/production/lots/${encodeURIComponent(entry.harvestLotId!)}/runs/${id}`;
  return null;
}
const names: Record<string, string> = {
  equipment: "Equipment",
  bulk: "Bulk honey",
  packaging: "Packaging",
  finished: "Finished goods",
};
export function StockWorkspace({
  category = "equipment",
  itemId,
}: {
  category?: string;
  itemId?: string;
}) {
  const access = useAccessProfile();
  const query = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  const location = query.get("locationId") ?? "any";
  const condition = query.get("condition") ?? "any";
  const lot = query.get("lotId") ?? "any";
  const hive = query.get("hiveId") ?? "any";
  const harvest = query.get("harvestLotId") ?? "any";
  const stock = useQuery({
    queryKey: [
      "stock",
      itemId ?? category,
      location,
      condition,
      lot,
      hive,
      harvest,
    ],
    enabled: access.data?.isAdmin === true,
    queryFn: async () => {
      const params = {
        ...(!itemId ? { kind: kinds[category] } : {}),
        locationId: location,
        condition,
        lotId: lot,
        hiveId: hive,
        harvestLotId: harvest,
      };
      const result = await api.getWithMeta<StockRead>(
        itemId ? `/stock/${itemId}` : "/stock",
        { params },
      );
      if (!itemId && category === "finished") {
        const products = await api.getWithMeta<StockRead>("/stock", {
          params: { ...params, kind: "catalog_product" },
        });
        const stale =
          result.meta.cache === "stale" ||
          products.meta.cache === "stale" ||
          result.data.freshness.stale ||
          products.data.freshness.stale;
        return {
          ...result.data,
          rows: [...result.data.rows, ...products.data.rows],
          freshness: stale
            ? { stale: true, origin: "cache" }
            : result.data.freshness,
        };
      }
      return {
        ...result.data,
        freshness:
          result.meta.cache === "stale"
            ? { stale: true, origin: "cache" }
            : result.data.freshness,
      };
    },
  });
  const kind = stock.data?.rows[0]?.kind;
  const actionCategory = itemId
    ? kind === "equipment"
      ? "equipment"
      : kind === "honey_bulk"
        ? "bulk"
        : "finished"
    : category;
  const rows = (stock.data?.rows ?? []).filter((r) =>
    `${r.itemName} ${r.lotCode ?? ""} ${r.locationName ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  function filter(key: string, value: string) {
    const next = new URLSearchParams(query);
    if (value === "any") next.delete(key);
    else next.set(key, value);
    router.push(`${pathname}?${next}`);
  }
  if (access.isPending) return <p>Loading access...</p>;
  if (!access.data?.isAdmin)
    return <p>Stock is available to operation administrators.</p>;
  return (
    <div className="atlas-workspace">
      <header className="atlas-heading">
        <div>
          <p className="atlas-eyebrow">
            Stock / {itemId ? "Item record" : "Inventory"}
          </p>
          <h1>
            {itemId
              ? (stock.data?.rows[0]?.itemName ?? "Stock item")
              : names[category]}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Physical stock, commitments, and what is available, in the same
            location and unit.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link
            href={
              actionCategory === "equipment"
                ? "/equipment"
                : actionCategory === "bulk"
                  ? "/production/lots"
                  : "/production/jars"
            }
          >
            {actionCategory === "equipment"
              ? "Counts & actions"
              : actionCategory === "bulk"
                ? "Manage lots"
                : "Bottling & counts"}
          </Link>
        </Button>
      </header>
      <SectionNav
        label="Stock pages"
        sections={NAV_ITEMS.find((i) => i.href === "/stock")!.children!}
        rootHref="/stock"
        pathname={pathname}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 gap-1 text-xs">
          Find stock
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Item, lot, or location"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-xs">
          Location
          <select
            className="min-h-11 max-w-full rounded-md border bg-card px-3 text-sm"
            value={location}
            onChange={(e) => filter("locationId", e.target.value)}
          >
            <option value="any">All locations, separate rows</option>
            <option value="null">Unassigned location</option>
            {Array.from(
              new Map(
                (stock.data?.rows ?? [])
                  .filter((r) => r.locationId)
                  .map((r) => [r.locationId!, r.locationName ?? r.locationId!]),
              ).entries(),
            ).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {location !== "any" &&
              location !== "null" &&
              !(stock.data?.rows ?? []).some(
                (r) => r.locationId === location,
              ) && <option value={location}>Selected location</option>}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          Condition
          <select
            className="min-h-11 rounded-md border bg-card px-3 text-sm"
            value={condition}
            onChange={(e) => filter("condition", e.target.value)}
          >
            <option value="any">Any condition</option>
            <option value="null">Unassigned</option>
            <option value="serviceable">Ready</option>
            <option value="damaged">Damaged</option>
            <option value="retired">Retired</option>
          </select>
        </label>
      </div>
      {stock.isPending ? (
        <p role="status">Loading stock...</p>
      ) : stock.isError ? (
        <div role="alert">
          Could not load stock.{" "}
          <Button variant="outline" onClick={() => stock.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {stock.data?.freshness.stale
              ? "Cached stock: connect and refresh before acting"
              : "Server stock"}
            {stock.data?.asOf
              ? ` / ${new Date(stock.data.asOf).toLocaleString()}`
              : ""}{" "}
            <button className="underline" onClick={() => stock.refetch()}>
              Refresh
            </button>
          </p>
          <div className="atlas-records">
            {rows.length === 0 ? (
              <p className="atlas-record text-sm text-muted-foreground">
                No stock matches this scope. Record a count or production
                activity to establish stock.
              </p>
            ) : (
              rows.map((row, index) => (
                <article
                  className="atlas-record grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)]"
                  key={`${row.itemId}-${index}`}
                >
                  <div>
                    <Link
                      className="font-semibold underline-offset-4 hover:underline"
                      href={`/stock/items/${row.itemId}?${new URLSearchParams({ locationId: row.locationId ?? "null", lotId: row.lotId ?? "null", condition: row.condition ?? "null", hiveId: row.hiveId ?? "null" })}`}
                    >
                      {row.itemName}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.locationName ?? "Unassigned location"} /{" "}
                      {row.condition ?? "Condition unassigned"}
                      {row.hiveId ? " / In field" : ""}
                    </p>
                    {row.harvestLotId && (
                      <Link
                        className="text-xs underline"
                        href={`/production/lots/${row.harvestLotId}`}
                      >
                        {row.lotCode ?? "Lot record"}
                      </Link>
                    )}
                    {!row.originKnown && (
                      <p className="text-xs text-muted-foreground">
                        Origin not recorded
                      </p>
                    )}
                    {row.holdsKnown === false && (
                      <p className="text-xs text-muted-foreground">
                        Action holds not checked. Review restrictions before
                        use.
                      </p>
                    )}
                    {row.holds?.map((hold, i) => (
                      <p key={i} className="text-xs text-destructive">
                        {hold.reason}
                        {hold.until ? ` / Until ${hold.until}` : ""}
                      </p>
                    ))}
                  </div>
                  <dl className="atlas-quantities">
                    {[
                      ["On hand", row.countKnown ? row.onHand : "Unknown"],
                      ["Reserved", row.reserved],
                      ["Available", row.countKnown ? row.available : "Unknown"],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          {value}{" "}
                          <span className="text-xs font-normal">
                            {row.unit}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Available = on hand minus reserved. Holds appear separately.
            Reservations belong to orders; use Sales to change a commitment.
          </p>
          {itemId && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Movement history</h2>
              <div className="atlas-records">
                {stock.data?.history?.length ? (
                  stock.data.history.map((entry, i) => (
                    <div
                      key={`${entry.operationId}-${i}`}
                      className="atlas-record flex flex-wrap justify-between gap-2"
                    >
                      <div>
                        <p className="font-medium">
                          {entry.kind.replaceAll("_", " ")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {entry.reason || "No reason recorded"} /{" "}
                          {new Date(entry.occurredAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="grid gap-1 text-right">
                        <span className="font-mono">
                          {entry.quantity} {stock.data?.rows[0]?.unit}
                        </span>
                        {sourceHref(entry) && (
                          <Link
                            className="text-xs underline"
                            href={sourceHref(entry)!}
                          >
                            Open {entry.sourceType.replaceAll("_", " ")}
                          </Link>
                        )}
                        {entry.hiveId && (
                          <Link
                            className="text-xs underline"
                            href={`/yard/hives/${entry.hiveId}`}
                          >
                            Hive record
                          </Link>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="atlas-record text-sm text-muted-foreground">
                    No recorded movements in this scope.
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
