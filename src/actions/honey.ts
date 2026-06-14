"use server";

import { requireSession } from "@/lib/require-session";
import { formValues, normalizeFormData } from "@/lib/form-values";
import { db } from "@/db";
import {
  honeyHarvests,
  honeySales,
  honeySaleItems,
  honeyMovements,
  jarSizes,
  hives,
  apiaries,
  harvestSessions,
} from "@/db/schema";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export interface JarLine {
  jarSizeId: string;
  quantity: number;
}

export interface SaleLine extends JarLine {
  unitPrice: number;
}


/** Parse a date-only string (YYYY-MM-DD) in local time, not UTC. */
function parseLocalDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

// ---------------------------------------------------------------------------
// Harvest entries (bulk honey in)
// ---------------------------------------------------------------------------

export async function createHarvest(_prevState: unknown, formData: FormData) {
  await requireSession();
  formData = normalizeFormData(formData);
  const hiveId = formData.get("hiveId") as string;
  const date = formData.get("date") as string;
  const superWeightBefore = formData.get("superWeightBefore") as string;
  const superWeightAfter = formData.get("superWeightAfter") as string;
  const notes = formData.get("notes") as string;

  if (!hiveId) return { error: "Hive is required", values: formValues(formData) };
  if (!date) return { error: "Date is required", values: formValues(formData) };
  if (!superWeightBefore || !superWeightAfter)
    return { error: "Both weights are required", values: formValues(formData) };

  const before = parseFloat(superWeightBefore);
  const after = parseFloat(superWeightAfter);
  const honeyWeight = before - after;

  if (honeyWeight < 0)
    return { error: "Weight before must be greater than weight after", values: formValues(formData) };

  await db.insert(honeyHarvests).values({
    hiveId,
    date: parseLocalDate(date),
    superWeightBefore: before,
    superWeightAfter: after,
    calculatedHoneyWeight: honeyWeight,
    notes: notes?.trim() || null,
  });

  revalidatePath("/harvest");
  redirect("/harvest");
}

export async function getHarvests() {
  await requireSession();
  return db
    .select({
      id: honeyHarvests.id,
      hiveId: honeyHarvests.hiveId,
      date: honeyHarvests.date,
      superWeightBefore: honeyHarvests.superWeightBefore,
      superWeightAfter: honeyHarvests.superWeightAfter,
      calculatedHoneyWeight: honeyHarvests.calculatedHoneyWeight,
      notes: honeyHarvests.notes,
      hiveName: hives.positionLabel,
      apiaryName: apiaries.name,
    })
    .from(honeyHarvests)
    .innerJoin(hives, eq(honeyHarvests.hiveId, hives.id))
    .innerJoin(apiaries, eq(hives.apiaryId, apiaries.id))
    .orderBy(desc(honeyHarvests.date));
}

// ---------------------------------------------------------------------------
// Movements (bulk honey out / jar lifecycle)
// ---------------------------------------------------------------------------

/**
 * Jar bulk honey into containers. Multi-line so a whole jarring session is
 * one entry; optionally records the sticky-loss from the same session.
 */
export async function recordJarring(input: {
  date: string;
  lines: JarLine[];
  lossLbs?: number;
  lossReason?: string;
  notes?: string;
}) {
  await requireSession();
  const lines = (input.lines ?? []).filter((l) => l.jarSizeId && l.quantity > 0);
  if (lines.length === 0 && !input.lossLbs) {
    return { error: "Add at least one jar line" };
  }
  const date = parseLocalDate(input.date);
  const sizes = lines.length
    ? await db
        .select()
        .from(jarSizes)
        .where(inArray(jarSizes.id, lines.map((l) => l.jarSizeId)))
    : [];
  const sizeById = new Map(sizes.map((s) => [s.id, s]));

  type MovementInsert = typeof honeyMovements.$inferInsert;
  const values: MovementInsert[] = lines.map((line) => {
    const oz = sizeById.get(line.jarSizeId)?.honeyOz ?? null;
    return {
      date,
      kind: "jarring",
      jarSizeId: line.jarSizeId,
      quantity: line.quantity,
      amountLbs: oz != null ? (oz * line.quantity) / 16 : null,
      notes: input.notes?.trim() || null,
    };
  });

  if (input.lossLbs && input.lossLbs > 0) {
    values.push({
      date,
      kind: "loss",
      amountLbs: input.lossLbs,
      reason: input.lossReason?.trim() || "jarring loss",
      notes: input.notes?.trim() || null,
    });
  }

  await db.insert(honeyMovements).values(values);
  revalidatePath("/harvest");
  return { success: true };
}

/** Bulk honey consumed directly (mead, baking, …) or written off. */
export async function recordBulkMovement(input: {
  date: string;
  kind: "bulk_use" | "loss";
  amountLbs: number;
  reason?: string;
  notes?: string;
}) {
  await requireSession();
  if (!input.amountLbs || input.amountLbs <= 0)
    return { error: "Amount must be greater than zero" };
  await db.insert(honeyMovements).values({
    date: parseLocalDate(input.date),
    kind: input.kind,
    amountLbs: input.amountLbs,
    reason: input.reason?.trim() || null,
    notes: input.notes?.trim() || null,
  });
  revalidatePath("/harvest");
  return { success: true };
}

/** Jars given away or consumed at home (no revenue). */
export async function recordGiveAway(input: {
  date: string;
  lines: JarLine[];
  reason?: string;
  notes?: string;
}) {
  await requireSession();
  const lines = (input.lines ?? []).filter((l) => l.jarSizeId && l.quantity > 0);
  if (lines.length === 0) return { error: "Add at least one jar line" };
  await db.insert(honeyMovements).values(
    lines.map((line) => ({
      date: parseLocalDate(input.date),
      kind: "give_away" as const,
      jarSizeId: line.jarSizeId,
      quantity: line.quantity,
      reason: input.reason?.trim() || null,
      notes: input.notes?.trim() || null,
    }))
  );
  revalidatePath("/harvest");
  return { success: true };
}

/** Manual jar-count corrections (bulk: one row per size, +/- deltas). */
export async function adjustJarCounts(input: {
  date: string;
  lines: Array<{ jarSizeId: string; delta: number }>;
  reason?: string;
}) {
  await requireSession();
  const lines = (input.lines ?? []).filter((l) => l.jarSizeId && l.delta !== 0);
  if (lines.length === 0) return { error: "No changes to apply" };
  await db.insert(honeyMovements).values(
    lines.map((line) => ({
      date: parseLocalDate(input.date),
      kind: "jar_adjustment" as const,
      jarSizeId: line.jarSizeId,
      quantity: line.delta,
      reason: input.reason?.trim() || "manual correction",
    }))
  );
  revalidatePath("/harvest");
  return { success: true };
}

export async function deleteMovement(id: string) {
  await requireSession();
  await db.delete(honeyMovements).where(eq(honeyMovements.id, id));
  revalidatePath("/harvest");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export async function recordSale(input: {
  date: string;
  location?: string;
  customerName?: string;
  lines: SaleLine[];
  notes?: string;
}) {
  await requireSession();
  const lines = (input.lines ?? []).filter((l) => l.jarSizeId && l.quantity > 0);
  if (lines.length === 0) return { error: "Add at least one line" };

  // Validate availability against the derived inventory.
  const inventory = await getJarInventory();
  const onHand = new Map(inventory.map((i) => [i.jarSizeId, i.onHand]));
  const labels = new Map(inventory.map((i) => [i.jarSizeId, i.label]));
  for (const line of lines) {
    const have = onHand.get(line.jarSizeId) ?? 0;
    if (line.quantity > have) {
      return {
        error: `Not enough ${labels.get(line.jarSizeId) ?? "jars"}: need ${line.quantity}, have ${have}`,
      };
    }
  }

  const totalAmount = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

  await db.transaction(async (tx) => {
    const [sale] = await tx
      .insert(honeySales)
      .values({
        date: parseLocalDate(input.date),
        customerName: input.customerName?.trim() || null,
        location: input.location?.trim() || null,
        totalAmount,
        notes: input.notes?.trim() || null,
      })
      .returning();
    await tx.insert(honeySaleItems).values(
      lines.map((l) => ({
        saleId: sale.id,
        jarSizeId: l.jarSizeId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      }))
    );
  });

  revalidatePath("/harvest");
  return { success: true };
}

export async function deleteSale(id: string) {
  await requireSession();
  await db.delete(honeySales).where(eq(honeySales.id, id));
  revalidatePath("/harvest");
  return { success: true };
}

export async function getSales() {
  await requireSession();
  const sales = await db.select().from(honeySales).orderBy(desc(honeySales.date));
  const items = await db
    .select({
      saleId: honeySaleItems.saleId,
      jarSizeId: honeySaleItems.jarSizeId,
      quantity: honeySaleItems.quantity,
      unitPrice: honeySaleItems.unitPrice,
      label: jarSizes.label,
    })
    .from(honeySaleItems)
    .innerJoin(jarSizes, eq(honeySaleItems.jarSizeId, jarSizes.id));

  const itemsBySale = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsBySale.get(item.saleId) ?? [];
    list.push(item);
    itemsBySale.set(item.saleId, list);
  }
  return sales.map((s) => ({ ...s, lineItems: itemsBySale.get(s.id) ?? [] }));
}

/** Distinct past sale locations for autocomplete. */
export async function getSaleLocations(): Promise<string[]> {
  await requireSession();
  const rows = await db
    .selectDistinct({ location: honeySales.location })
    .from(honeySales);
  return rows.map((r) => r.location).filter((l): l is string => Boolean(l));
}

// ---------------------------------------------------------------------------
// Derived inventory + overview
// ---------------------------------------------------------------------------

export interface JarInventoryRow {
  jarSizeId: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  jarred: number;
  sold: number;
  givenAway: number;
  adjusted: number;
  onHand: number;
}

/** Jar counts derived from the ledger: jarred + adjustments − sold − given. */
export async function getJarInventory(): Promise<JarInventoryRow[]> {
  await requireSession();
  const sizes = await db
    .select()
    .from(jarSizes)
    .orderBy(jarSizes.sortOrder, jarSizes.label);

  const movementTotals = await db
    .select({
      jarSizeId: honeyMovements.jarSizeId,
      kind: honeyMovements.kind,
      total: sql<number>`coalesce(sum(${honeyMovements.quantity}), 0)`,
    })
    .from(honeyMovements)
    .groupBy(honeyMovements.jarSizeId, honeyMovements.kind);

  const soldTotals = await db
    .select({
      jarSizeId: honeySaleItems.jarSizeId,
      total: sql<number>`coalesce(sum(${honeySaleItems.quantity}), 0)`,
    })
    .from(honeySaleItems)
    .groupBy(honeySaleItems.jarSizeId);

  const byKind = (sizeId: string, kind: string) =>
    Number(
      movementTotals.find((m) => m.jarSizeId === sizeId && m.kind === kind)
        ?.total ?? 0
    );
  const soldBySize = new Map(soldTotals.map((s) => [s.jarSizeId, Number(s.total)]));

  return sizes.map((size) => {
    const jarred = byKind(size.id, "jarring");
    const givenAway = byKind(size.id, "give_away");
    const adjusted = byKind(size.id, "jar_adjustment");
    const sold = soldBySize.get(size.id) ?? 0;
    return {
      jarSizeId: size.id,
      label: size.label,
      honeyOz: size.honeyOz,
      defaultPrice: size.defaultPrice,
      jarred,
      sold,
      givenAway,
      adjusted,
      onHand: jarred + adjusted - sold - givenAway,
    };
  });
}

export interface HoneyOverview {
  totalHarvestedLbs: number;
  jarredLbs: number;
  bulkUsedLbs: number;
  lossLbs: number;
  bulkOnHandLbs: number;
  totalRevenue: number;
  jarsSold: number;
  inventory: JarInventoryRow[];
}

export async function getHoneyOverview(): Promise<HoneyOverview> {
  await requireSession();
  const [sessions, harvests, bulkByKind, revenue, soldCount, inventory] =
    await Promise.all([
      db
        .select({
          total: sql<number>`coalesce(sum(${harvestSessions.totalExtractedWeight}), 0)`,
        })
        .from(harvestSessions),
      db
        .select({
          total: sql<number>`coalesce(sum(${honeyHarvests.calculatedHoneyWeight}), 0)`,
        })
        .from(honeyHarvests),
      db
        .select({
          kind: honeyMovements.kind,
          total: sql<number>`coalesce(sum(${honeyMovements.amountLbs}), 0)`,
        })
        .from(honeyMovements)
        .groupBy(honeyMovements.kind),
      db
        .select({
          total: sql<number>`coalesce(sum(${honeySales.totalAmount}), 0)`,
        })
        .from(honeySales),
      db
        .select({
          total: sql<number>`coalesce(sum(${honeySaleItems.quantity}), 0)`,
        })
        .from(honeySaleItems),
      getJarInventory(),
    ]);

  const sessionTotal = Number(sessions[0]?.total ?? 0);
  const harvestTotal = Number(harvests[0]?.total ?? 0);
  // Sessions hold the authoritative extracted weight when used; per-hive
  // harvest entries are the fallback.
  const totalHarvestedLbs = sessionTotal > 0 ? sessionTotal : harvestTotal;

  const lbsByKind = (kind: string) =>
    Number(bulkByKind.find((b) => b.kind === kind)?.total ?? 0);
  const jarredLbs = lbsByKind("jarring");
  const bulkUsedLbs = lbsByKind("bulk_use");
  const lossLbs = lbsByKind("loss");

  return {
    totalHarvestedLbs,
    jarredLbs,
    bulkUsedLbs,
    lossLbs,
    bulkOnHandLbs: totalHarvestedLbs - jarredLbs - bulkUsedLbs - lossLbs,
    totalRevenue: Number(revenue[0]?.total ?? 0),
    jarsSold: Number(soldCount[0]?.total ?? 0),
    inventory,
  };
}

/** Unified activity feed: movements + sales, newest first. */
export interface TimelineEntry {
  id: string;
  date: Date;
  type: "jarring" | "bulk_use" | "loss" | "give_away" | "jar_adjustment" | "sale";
  description: string;
  amountLbs: number | null;
  quantity: number | null;
  totalAmount: number | null;
  notes: string | null;
}

export async function getHoneyTimeline(limit = 50): Promise<TimelineEntry[]> {
  await requireSession();
  const [movements, sales] = await Promise.all([
    db
      .select({
        id: honeyMovements.id,
        date: honeyMovements.date,
        kind: honeyMovements.kind,
        amountLbs: honeyMovements.amountLbs,
        quantity: honeyMovements.quantity,
        reason: honeyMovements.reason,
        notes: honeyMovements.notes,
        sizeLabel: jarSizes.label,
      })
      .from(honeyMovements)
      .leftJoin(jarSizes, eq(honeyMovements.jarSizeId, jarSizes.id))
      .orderBy(desc(honeyMovements.date))
      .limit(limit),
    getSales(),
  ]);

  const entries: TimelineEntry[] = movements.map((m) => ({
    id: m.id,
    date: m.date,
    type: m.kind,
    description:
      m.kind === "jarring"
        ? `Jarred ${m.quantity} × ${m.sizeLabel ?? "?"}`
        : m.kind === "give_away"
          ? `Gave away ${m.quantity} × ${m.sizeLabel ?? "?"}${m.reason ? ` (${m.reason})` : ""}`
          : m.kind === "jar_adjustment"
            ? `Adjusted ${m.sizeLabel ?? "?"} by ${m.quantity != null && m.quantity > 0 ? "+" : ""}${m.quantity}${m.reason ? ` (${m.reason})` : ""}`
            : m.kind === "bulk_use"
              ? `Used ${m.amountLbs?.toFixed(1)} lbs bulk${m.reason ? ` (${m.reason})` : ""}`
              : `Loss ${m.amountLbs?.toFixed(1)} lbs${m.reason ? ` (${m.reason})` : ""}`,
    amountLbs: m.amountLbs,
    quantity: m.quantity,
    totalAmount: null,
    notes: m.notes,
  }));

  for (const sale of sales.slice(0, limit)) {
    const lineSummary = sale.lineItems
      .map((i) => `${i.quantity} × ${i.label}`)
      .join(", ");
    entries.push({
      id: sale.id,
      date: sale.date,
      type: "sale",
      description: `Sold ${lineSummary || "items"}${sale.location ? ` @ ${sale.location}` : ""}${sale.customerName ? ` to ${sale.customerName}` : ""}`,
      amountLbs: null,
      quantity: sale.lineItems.reduce((s, i) => s + i.quantity, 0),
      totalAmount: sale.totalAmount,
      notes: sale.notes,
    });
  }

  return entries
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);
}
