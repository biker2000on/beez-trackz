"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { equipmentTypes, equipmentStock, equipmentStockAdjustments, equipmentDeployments, hives } from "@/db/schema";
import { eq, isNull, desc, sql, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// ============================================
// Equipment Types
// ============================================

export async function getEquipmentTypes() {
  await requireSession();
  return db.select().from(equipmentTypes).orderBy(equipmentTypes.category, equipmentTypes.name);
}

export async function createEquipmentType(_prevState: unknown, formData: FormData) {
  await requireSession();
  const name = formData.get("name") as string;
  const category = formData.get("category") as string;

  const framesPerBox = formData.get("framesPerBox") as string;

  if (!name?.trim()) return { error: "Name is required" };
  if (!category) return { error: "Category is required" };

  await db.insert(equipmentTypes).values({
    name: name.trim(),
    category: category as "box" | "cover" | "bottom" | "accessory" | "frame" | "other",
    framesPerBox: framesPerBox ? parseInt(framesPerBox) : null,
  });

  revalidatePath("/settings/equipment");
  return { success: true };
}

// ============================================
// Equipment Stock
// ============================================

export async function getEquipmentStock() {
  await requireSession();
  const stock = await db
    .select({
      id: equipmentStock.id,
      typeId: equipmentStock.typeId,
      typeName: equipmentTypes.name,
      typeCategory: equipmentTypes.category,
      totalOwned: equipmentStock.totalOwned,
      storageLocation: equipmentStock.storageLocation,
      notes: equipmentStock.notes,
      frameCondition: equipmentStock.frameCondition,
      framesPerBox: equipmentTypes.framesPerBox,
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
  await requireSession();
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
  await requireSession();
  return db
    .select()
    .from(equipmentStockAdjustments)
    .where(eq(equipmentStockAdjustments.stockId, stockId))
    .orderBy(desc(equipmentStockAdjustments.date));
}

// Initialize stock for a type (when first adding stock for a type)
export async function createStock(_prevState: unknown, formData: FormData) {
  await requireSession();
  const typeId = formData.get("typeId") as string;
  const initialQuantity = parseInt(formData.get("initialQuantity") as string) || 0;
  const storageLocation = formData.get("storageLocation") as string;
  const notes = formData.get("notes") as string;
  const frameCondition = formData.get("frameCondition") as string;

  if (!typeId) return { error: "Equipment type is required" };

  await db.transaction(async (tx) => {
    const [stock] = await tx.insert(equipmentStock).values({
      typeId,
      totalOwned: initialQuantity,
      frameCondition: frameCondition ? (frameCondition as "drawn" | "fresh") : null,
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
  await requireSession();
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
  await requireSession();
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
  await requireSession();
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
// Frame Summary
// ============================================

export async function getFrameSummary() {
  await requireSession();
  // Get all frame stock (category = "frame")
  const frameStock = await db
    .select({
      id: equipmentStock.id,
      typeName: equipmentTypes.name,
      totalOwned: equipmentStock.totalOwned,
      frameCondition: equipmentStock.frameCondition,
    })
    .from(equipmentStock)
    .innerJoin(equipmentTypes, eq(equipmentStock.typeId, equipmentTypes.id))
    .where(eq(equipmentTypes.category, "frame"));

  // Get deployed frame counts
  const deployedFrameCounts = await db
    .select({
      stockId: equipmentDeployments.stockId,
      deployed: sql<number>`coalesce(sum(${equipmentDeployments.quantity}), 0)`,
    })
    .from(equipmentDeployments)
    .where(isNull(equipmentDeployments.dateRemoved))
    .groupBy(equipmentDeployments.stockId);

  const deployedMap: Record<string, number> = {};
  deployedFrameCounts.forEach(d => { deployedMap[d.stockId] = Number(d.deployed); });

  // Calculate standalone frame totals
  let totalDrawn = 0;
  let totalFresh = 0;
  let totalUnspecified = 0;

  for (const s of frameStock) {
    const available = s.totalOwned - (deployedMap[s.id] || 0);
    if (s.frameCondition === "drawn") totalDrawn += available;
    else if (s.frameCondition === "fresh") totalFresh += available;
    else totalUnspecified += available;
  }

  // Get boxes with framesPerBox that are deployed (frames in use in hives)
  const boxFrames = await db
    .select({
      typeName: equipmentTypes.name,
      framesPerBox: equipmentTypes.framesPerBox,
      deployedQty: sql<number>`coalesce(sum(${equipmentDeployments.quantity}), 0)`,
    })
    .from(equipmentDeployments)
    .innerJoin(equipmentStock, eq(equipmentDeployments.stockId, equipmentStock.id))
    .innerJoin(equipmentTypes, eq(equipmentStock.typeId, equipmentTypes.id))
    .where(and(
      isNull(equipmentDeployments.dateRemoved),
      eq(equipmentTypes.category, "box"),
      sql`${equipmentTypes.framesPerBox} is not null`
    ))
    .groupBy(equipmentTypes.name, equipmentTypes.framesPerBox);

  let totalBoxFrameCapacity = 0;
  const boxBreakdown = boxFrames.map(b => {
    const capacity = Number(b.framesPerBox || 0) * Number(b.deployedQty);
    totalBoxFrameCapacity += capacity;
    return {
      boxType: b.typeName,
      framesPerBox: Number(b.framesPerBox),
      deployedBoxes: Number(b.deployedQty),
      totalFrameCapacity: capacity,
    };
  });

  return {
    standalone: {
      drawn: totalDrawn,
      fresh: totalFresh,
      unspecified: totalUnspecified,
      total: totalDrawn + totalFresh + totalUnspecified,
    },
    boxFrameCapacity: totalBoxFrameCapacity,
    boxBreakdown,
    grandTotal: totalDrawn + totalFresh + totalUnspecified + totalBoxFrameCapacity,
  };
}

// ============================================
// Seed default equipment types
// ============================================

export async function seedDefaultEquipmentTypes() {
  await requireSession();
  const defaults: { name: string; category: "box" | "cover" | "bottom" | "accessory" | "frame" | "other"; framesPerBox?: number }[] = [
    { name: "Deep Box", category: "box", framesPerBox: 10 },
    { name: "Medium Super", category: "box", framesPerBox: 10 },
    { name: "Shallow Super", category: "box", framesPerBox: 10 },
    { name: "Queen Excluder", category: "accessory" },
    { name: "Inner Cover", category: "cover" },
    { name: "Outer Cover", category: "cover" },
    { name: "Bottom Board", category: "bottom" },
    { name: "Screened Bottom Board", category: "bottom" },
    { name: "Entrance Reducer", category: "accessory" },
    { name: "Feeder", category: "accessory" },
    { name: "Mouse Guard", category: "accessory" },
    { name: "Deep Frame", category: "frame" },
    { name: "Medium Frame", category: "frame" },
    { name: "Shallow Frame", category: "frame" },
  ];

  for (const d of defaults) {
    const existing = await db.select().from(equipmentTypes).where(eq(equipmentTypes.name, d.name)).limit(1);
    if (existing.length === 0) {
      await db.insert(equipmentTypes).values({ ...d, isDefault: true });
    } else if ('framesPerBox' in d && d.framesPerBox && !existing[0].framesPerBox) {
      // Update existing box types with framesPerBox if not set
      await db.update(equipmentTypes).set({ framesPerBox: d.framesPerBox }).where(eq(equipmentTypes.id, existing[0].id));
    }
  }
}
