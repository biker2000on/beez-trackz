"use client";

/**
 * Finished stock, the one way every page counts it.
 *
 * Four pages used to compute "available" for themselves and disagreed: the
 * production workbench's `jarStock` sums `inventory_available` over every
 * location (jars standing at the bike shop included), `/stock-locations`'
 * `onHandUnits` sums every item kind at a location (bulk pounds and empty
 * jars included), and Market day summed the home shelf. Only the last one is
 * what the operator can sell on Saturday.
 *
 * This hook reads the ledger's per-location split (`GET
 * /stock-locations/inventory`, the same read Market day sells from) and the
 * per-size target from Setup › Jar sizes (`GET /jar-sizes`,
 * `lowStockThreshold`), and answers the same facts to Today, In progress,
 * Market day and Consignment:
 *
 * - `jarsAtHome` / `unitsAtHome`: jars (and catalog products) standing at the
 *   home location, i.e. what Market day can sell.
 * - `jarsAway`: jars standing at consignment shops.
 * - `belowTarget`: active sizes whose home count is under their target. An
 *   inactive size is never below target, however empty it is.
 *
 * Nothing here recomputes a balance: every number is a cell of the ledger's
 * own matrix.
 */

import { useJarSizes } from "@/features/settings/api";

import { useStockInventory } from "./stock-locations-api";

export interface FinishedSize {
  jarSizeId: string;
  label: string;
  isActive: boolean;
  /** Jars of this size at the home location. */
  atHome: number;
  /** Jars of this size at every other location (consignment shelves). */
  away: number;
  /** Setup › Jar sizes low-stock threshold. */
  target: number;
  /** Active and under target at home. */
  belowTarget: boolean;
}

export interface FinishedStock {
  homeId: string | null;
  /** Every active size, plus inactive sizes that still hold jars; catalog order. */
  sizes: FinishedSize[];
  /** Sizes with at least one jar at home. */
  stockedAtHome: FinishedSize[];
  belowTarget: FinishedSize[];
  jarsAtHome: number;
  jarsAway: number;
  /** Catalog products (creamed, candles …) at home. */
  productsAtHome: number;
  /** Jars plus products at home: what Market day lists. */
  unitsAtHome: number;
}

export function useFinishedStock(enabled = true) {
  const inventory = useStockInventory(enabled);
  const jarSizes = useJarSizes(enabled);

  const data: FinishedStock | undefined =
    inventory.data && jarSizes.data
      ? composeFinishedStock(inventory.data, jarSizes.data)
      : undefined;

  return {
    data,
    isPending: inventory.isPending || jarSizes.isPending,
    isError: inventory.isError || jarSizes.isError,
    refetch: () => {
      void inventory.refetch();
      void jarSizes.refetch();
    },
  };
}

export function composeFinishedStock(
  inventory: {
    locations: { id: string; isHome: boolean }[];
    items: {
      jarSizeId: string | null;
      productId: string | null;
      total: number;
      byLocation: Record<string, number>;
    }[];
  },
  jarSizes: {
    id: string;
    label: string;
    isActive: boolean;
    lowStockThreshold: number;
  }[],
): FinishedStock {
  // A body that is not the matrix (an older server, a mocked read) counts as
  // nothing on hand rather than a crash of every page that counts.
  const locations = Array.isArray(inventory?.locations) ? inventory.locations : [];
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  const sizes0 = Array.isArray(jarSizes) ? jarSizes : [];
  const homeId = locations.find((location) => location.isHome)?.id ?? null;
  const atHomeOf = (row: { byLocation: Record<string, number> }) =>
    homeId ? (row.byLocation?.[homeId] ?? 0) : 0;

  const sizes: FinishedSize[] = sizes0
    .map((size) => {
      const row = items.find((item) => item.jarSizeId === size.id);
      const atHome = row ? atHomeOf(row) : 0;
      const away = row ? Math.max(0, row.total - atHome) : 0;
      const target = size.lowStockThreshold ?? 0;
      return {
        jarSizeId: size.id,
        label: size.label,
        isActive: size.isActive,
        atHome,
        away,
        target,
        belowTarget: size.isActive && atHome < target,
      };
    })
    .filter((size) => size.isActive || size.atHome + size.away > 0);

  const jarsAtHome = sizes.reduce((sum, size) => sum + size.atHome, 0);
  const jarsAway = sizes.reduce((sum, size) => sum + size.away, 0);
  const productsAtHome = items
    .filter((item) => item.jarSizeId == null && item.productId != null)
    .reduce((sum, item) => sum + atHomeOf(item), 0);

  return {
    homeId,
    sizes,
    stockedAtHome: sizes.filter((size) => size.atHome > 0),
    belowTarget: sizes.filter((size) => size.belowTarget),
    jarsAtHome,
    jarsAway,
    productsAtHome,
    unitsAtHome: jarsAtHome + productsAtHome,
  };
}
