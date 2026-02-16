"use server";

import { db } from "@/db";
import { equipmentTypes, equipmentStock, equipmentStockAdjustments, equipmentDeployments, hives } from "@/db/schema";
import { eq, isNull, desc, sql, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// ============================================
// Equipment Types
// ============================================

export async function getEquipmentTypes() {
  return db.select().from(equipmentTypes).orderBy(equipmentTypes.category, equipmentTypes.name);
}

export async function createEquipmentType(_prevState: unknown, formData: FormData) {
  const name = formData.get("name") as string;
  const category = formData.get("category") as string;

  if (!name?.trim()) return { error: "Name is required" };
  if (!category) return { error: "Category is required" };

  await db.insert(equipmentTypes).values({
    name: name.trim(),
    category: category as "box" | "cover" | "bottom" | "accessory" | "other",
  });

  revalidatePath("/settings/equipment");
  return { success: true };
}

// ============================================
// Equipment Stock
// ============================================

export async function getEquipmentStock() {
  const stock = await db
    .select({
      id: equipmentStock.id,
      typeId: equipmentStock.typeId,
      typeName: equipmentTypes.name,
      typeCategory: equipmentTypes.category,
      totalOwned: equipmentStock.totalOwned,
      storageLocation: equipmentStock.storageLocation,
      notes: equipmentStock.notes,
    })
    .from(equipmentStock)
    .innerJoin(equipmentTypes, eq(equipmentStock.typeId, equipmentTypes.id))
    .orderBy(equipmentTypes.category, equipmentTypes.name);

  // Get deployed counts per stock item
  const deployedCounts = await db
    .select({
      stockId: equipmentDeployments.stockId,
      deployed: sql<number>`coalesce(sum(${equipmentDeployments.quantity}), 0)`,
    })
    .from(equipmentDeployments)
    .where(isNull(equipmentDeployments.dateRemoved))
    .groupBy(equipmentDeployments.stockId);

  const deployedMap: Record<string, number> = {};
  deployedCounts.forEach(d => { deployedMap[d.stockId] = Number(d.deployed); });

  return stock.map(s => ({
    ...s,
    deployed: deployedMap[s.id] || 0,
    available: s.totalOwned - (deployedMap[s.id] || 0),
  }));
}

export async function adjustStock(_prevState: unknown, formData: FormData) {
  const stockId = formData.get("stockId") as string;
  const quantity = parseInt(formData.get("quantity") as string);
  const reason = formData.get("reason") as string;
  const notes = formData.get("notes") as string;
  const date = formData.get("date") as string;

  if (!stockId) return { error: "Stock item is required" };
  if (!quantity || quantity === 0) return { error: "Quantity must be non-zero" };
  if (!reason) return { error: "Reason is required" };

  await db.transaction(async (tx) => {
    // Create adjustment record
    await tx.insert(equipmentStockAdjustments).values({
      stockId,
      quantity,
      reason: reason as "purchased" | "built" | "discarded" | "broken" | "gifted" | "other",
      notes: notes?.trim() || null,
      date: date ? new Date(date) : new Date(),
    });

    // Update totalOwned
    await tx
      .update(equipmentStock)
      .set({
        totalOwned: sql`${equipmentStock.totalOwned} + ${quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(equipmentStock.id, stockId));
  });

  revalidatePath("/settings/equipment");
  return { success: true };
}

export async function getStockAdjustments(stockId: string) {
  return db
    .select()
    .from(equipmentStockAdjustments)
    .where(eq(equipmentStockAdjustments.stockId, stockId))
    .orderBy(desc(equipmentStockAdjustments.date));
}

// Initialize stock for a type (when first adding stock for a type)
export async function createStock(_prevState: unknown, formData: FormData) {
  const typeId = formData.get("typeId") as string;
  const initialQuantity = parseInt(formData.get("initialQuantity") as string) || 0;
  const storageLocation = formData.get("storageLocation") as string;
  const notes = formData.get("notes") as string;

  if (!typeId) return { error: "Equipment type is required" };

  await db.transaction(async (tx) => {
    const [stock] = await tx.insert(equipmentStock).values({
      typeId,
      totalOwned: initialQuantity,
      storageLocation: storageLocation?.trim() || null,
      notes: notes?.trim() || null,
    }).returning();

    if (initialQuantity > 0) {
      await tx.insert(equipmentStockAdjustments).values({
        stockId: stock.id,
        quantity: initialQuantity,
        reason: "purchased",
        notes: "Initial stock",
        date: new Date(),
      });
    }
  });

  revalidatePath("/settings/equipment");
  return { success: true };
}

// ============================================
// Equipment Deployments
// ============================================

export async function deployEquipment(_prevState: unknown, formData: FormData) {
  const stockId = formData.get("stockId") as string;
  const hiveId = formData.get("hiveId") as string;
  const quantity = parseInt(formData.get("quantity") as string) || 1;
  const notes = formData.get("notes") as string;

  if (!stockId) return { error: "Equipment stock is required" };
  if (!hiveId) return { error: "Hive is required" };
  if (quantity < 1) return { error: "Quantity must be at least 1" };

  await db.insert(equipmentDeployments).values({
    stockId,
    hiveId,
    quantity,
    dateDeployed: new Date(),
    notes: notes?.trim() || null,
  });

  revalidatePath("/settings/equipment");
  revalidatePath(`/hives/${hiveId}`);
  return { success: true };
}

export async function removeDeployment(deploymentId: string) {
  const [deployment] = await db
    .select({ hiveId: equipmentDeployments.hiveId })
    .from(equipmentDeployments)
    .where(eq(equipmentDeployments.id, deploymentId))
    .limit(1);

  await db
    .update(equipmentDeployments)
    .set({ dateRemoved: new Date() })
    .where(eq(equipmentDeployments.id, deploymentId));

  revalidatePath("/settings/equipment");
  if (deployment?.hiveId) {
    revalidatePath(`/hives/${deployment.hiveId}`);
  }
}

export async function getDeploymentsForHive(hiveId: string) {
  return db
    .select({
      id: equipmentDeployments.id,
      stockId: equipmentDeployments.stockId,
      quantity: equipmentDeployments.quantity,
      dateDeployed: equipmentDeployments.dateDeployed,
      dateRemoved: equipmentDeployments.dateRemoved,
      notes: equipmentDeployments.notes,
      typeName: equipmentTypes.name,
      typeCategory: equipmentTypes.category,
    })
    .from(equipmentDeployments)
    .innerJoin(equipmentStock, eq(equipmentDeployments.stockId, equipmentStock.id))
    .innerJoin(equipmentTypes, eq(equipmentStock.typeId, equipmentTypes.id))
    .where(eq(equipmentDeployments.hiveId, hiveId))
    .orderBy(desc(equipmentDeployments.dateDeployed));
}

// ============================================
// Seed default equipment types
// ============================================

export async function seedDefaultEquipmentTypes() {
  const defaults = [
    { name: "Deep Box", category: "box" as const },
    { name: "Medium Super", category: "box" as const },
    { name: "Shallow Super", category: "box" as const },
    { name: "Queen Excluder", category: "accessory" as const },
    { name: "Inner Cover", category: "cover" as const },
    { name: "Outer Cover", category: "cover" as const },
    { name: "Bottom Board", category: "bottom" as const },
    { name: "Screened Bottom Board", category: "bottom" as const },
    { name: "Entrance Reducer", category: "accessory" as const },
    { name: "Feeder", category: "accessory" as const },
    { name: "Mouse Guard", category: "accessory" as const },
  ];

  for (const d of defaults) {
    const existing = await db.select().from(equipmentTypes).where(eq(equipmentTypes.name, d.name)).limit(1);
    if (existing.length === 0) {
      await db.insert(equipmentTypes).values({ ...d, isDefault: true });
    }
  }
}
