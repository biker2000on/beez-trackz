"use server";

import { db } from "@/db";
import {
  honeyHarvests,
  honeyInventory,
  honeySales,
  hives,
  apiaries,
} from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createHarvest(
  _prevState: unknown,
  formData: FormData
) {
  const hiveId = formData.get("hiveId") as string;
  const date = formData.get("date") as string;
  const superWeightBefore = formData.get("superWeightBefore") as string;
  const superWeightAfter = formData.get("superWeightAfter") as string;
  const notes = formData.get("notes") as string;

  if (!hiveId) return { error: "Hive is required" };
  if (!date) return { error: "Date is required" };
  if (!superWeightBefore || !superWeightAfter)
    return { error: "Both weights are required" };

  const before = parseFloat(superWeightBefore);
  const after = parseFloat(superWeightAfter);
  const honeyWeight = before - after;

  if (honeyWeight < 0)
    return { error: "Weight before must be greater than weight after" };

  await db.insert(honeyHarvests).values({
    hiveId,
    date: new Date(date),
    superWeightBefore: before,
    superWeightAfter: after,
    calculatedHoneyWeight: honeyWeight,
    notes: notes?.trim() || null,
  });

  revalidatePath("/harvest");
  redirect("/harvest");
}

export async function createJarring(
  _prevState: unknown,
  formData: FormData
) {
  const jarSize = formData.get("jarSize") as string;
  const quantity = formData.get("quantity") as string;
  const harvestId = formData.get("harvestId") as string;

  if (!jarSize) return { error: "Jar size is required" };
  if (!quantity) return { error: "Quantity is required" };

  await db.insert(honeyInventory).values({
    jarSize: jarSize.trim(),
    quantity: parseInt(quantity),
    harvestId: harvestId || null,
  });

  revalidatePath("/harvest");
  redirect("/harvest");
}

export async function createSale(
  _prevState: unknown,
  formData: FormData
) {
  const date = formData.get("date") as string;
  const customerName = formData.get("customerName") as string;
  const itemsJson = formData.get("items") as string;
  const notes = formData.get("notes") as string;

  if (!date) return { error: "Date is required" };
  if (!itemsJson) return { error: "At least one item is required" };

  const items = JSON.parse(itemsJson) as Array<{
    jarSize: string;
    quantity: number;
    pricePerUnit: number;
  }>;

  if (items.length === 0) return { error: "At least one item is required" };

  const totalAmount = items.reduce(
    (sum, item) => sum + item.quantity * item.pricePerUnit,
    0
  );

  // Deduct from inventory inside a transaction
  await db.transaction(async (tx) => {
    for (const item of items) {
      // Find inventory rows for this jar size and deduct FIFO
      const inventoryRows = await tx
        .select()
        .from(honeyInventory)
        .where(eq(honeyInventory.jarSize, item.jarSize))
        .orderBy(honeyInventory.createdAt);

      let remaining = item.quantity;
      for (const row of inventoryRows) {
        if (remaining <= 0) break;
        const deduct = Math.min(remaining, row.quantity);
        const newQty = row.quantity - deduct;
        if (newQty <= 0) {
          await tx
            .delete(honeyInventory)
            .where(eq(honeyInventory.id, row.id));
        } else {
          await tx
            .update(honeyInventory)
            .set({ quantity: newQty, updatedAt: new Date() })
            .where(eq(honeyInventory.id, row.id));
        }
        remaining -= deduct;
      }
    }

    await tx.insert(honeySales).values({
      date: new Date(date),
      customerName: customerName?.trim() || null,
      items,
      totalAmount,
      notes: notes?.trim() || null,
    });
  });

  revalidatePath("/harvest");
  redirect("/harvest");
}

export async function getHarvests() {
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

export async function getHoneyInventory() {
  return db
    .select({
      jarSize: honeyInventory.jarSize,
      totalQuantity:
        sql<number>`cast(sum(${honeyInventory.quantity}) as integer)`,
    })
    .from(honeyInventory)
    .groupBy(honeyInventory.jarSize)
    .orderBy(honeyInventory.jarSize);
}

export async function getSales() {
  return db
    .select()
    .from(honeySales)
    .orderBy(desc(honeySales.date));
}

export async function getHoneyDashboard() {
  const [harvests, inventory, sales] = await Promise.all([
    db
      .select({
        total: sql<number>`coalesce(sum(${honeyHarvests.calculatedHoneyWeight}), 0)`,
      })
      .from(honeyHarvests),
    getHoneyInventory(),
    db
      .select({
        total: sql<number>`coalesce(sum(${honeySales.totalAmount}), 0)`,
      })
      .from(honeySales),
  ]);

  return {
    totalHarvested: Number(harvests[0]?.total || 0),
    inventory,
    totalRevenue: Number(sales[0]?.total || 0),
  };
}
