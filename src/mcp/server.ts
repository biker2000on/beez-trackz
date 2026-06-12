#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, desc, sql, and, isNull } from "drizzle-orm";
import * as schema from "../db/schema";

// --- Database connection (standalone, not imported from Next.js) ---
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}
const client = postgres(DATABASE_URL);
const db = drizzle(client, { schema });

// --- MCP Server ---
const server = new McpServer({
  name: "beez-trackz",
  version: "1.0.0",
  description:
    "Beekeeping management system - manage hives, apiaries, queens, inspections, feedings, harvests, and equipment",
});

// Helper for consistent JSON responses
function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error}` }],
    isError: true as const,
  };
}

// ============================================================
// APIARIES
// ============================================================

server.tool(
  "list_apiaries",
  "List all apiaries with active hive counts",
  {},
  async () => {
    try {
      const result = await db
        .select({
          id: schema.apiaries.id,
          name: schema.apiaries.name,
          latitude: schema.apiaries.latitude,
          longitude: schema.apiaries.longitude,
          notes: schema.apiaries.notes,
          createdAt: schema.apiaries.createdAt,
          hiveCount: sql<number>`count(${schema.hives.id})`,
        })
        .from(schema.apiaries)
        .leftJoin(
          schema.hives,
          and(
            eq(schema.apiaries.id, schema.hives.apiaryId),
            eq(schema.hives.isArchived, false),
            isNull(schema.hives.deadoutDate),
          ),
        )
        .groupBy(schema.apiaries.id)
        .orderBy(schema.apiaries.name);

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "get_apiary",
  "Get a single apiary by ID with its details",
  { id: z.string().describe("Apiary UUID") },
  async ({ id }) => {
    try {
      const [apiary] = await db
        .select()
        .from(schema.apiaries)
        .where(eq(schema.apiaries.id, id));
      if (!apiary) return errorResult("Apiary not found");

      const hives = await db
        .select()
        .from(schema.hives)
        .where(eq(schema.hives.apiaryId, id))
        .orderBy(schema.hives.positionLabel);

      return jsonResult({ ...apiary, hives });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "create_apiary",
  "Create a new apiary",
  {
    name: z.string().describe("Name of the apiary"),
    latitude: z.number().optional().describe("GPS latitude"),
    longitude: z.number().optional().describe("GPS longitude"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ name, latitude, longitude, notes }) => {
    try {
      const [apiary] = await db
        .insert(schema.apiaries)
        .values({ name, latitude, longitude, notes })
        .returning();
      return jsonResult(apiary);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "update_apiary",
  "Update an existing apiary",
  {
    id: z.string().describe("Apiary UUID"),
    name: z.string().optional().describe("New name"),
    latitude: z.number().optional().describe("New GPS latitude"),
    longitude: z.number().optional().describe("New GPS longitude"),
    notes: z.string().optional().describe("New notes"),
  },
  async ({ id, ...updates }) => {
    try {
      // Filter out undefined values
      const data: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.name !== undefined) data.name = updates.name;
      if (updates.latitude !== undefined) data.latitude = updates.latitude;
      if (updates.longitude !== undefined) data.longitude = updates.longitude;
      if (updates.notes !== undefined) data.notes = updates.notes;

      const [apiary] = await db
        .update(schema.apiaries)
        .set(data)
        .where(eq(schema.apiaries.id, id))
        .returning();
      if (!apiary) return errorResult("Apiary not found");
      return jsonResult(apiary);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// HIVES
// ============================================================

server.tool(
  "list_hives",
  "List hives, optionally filtered by apiary. By default excludes archived hives.",
  {
    apiaryId: z.string().optional().describe("Filter by apiary UUID"),
    includeArchived: z
      .boolean()
      .optional()
      .describe("Include archived hives (default: false)"),
  },
  async ({ apiaryId, includeArchived }) => {
    try {
      const conditions = [];
      if (apiaryId) conditions.push(eq(schema.hives.apiaryId, apiaryId));
      if (!includeArchived) conditions.push(eq(schema.hives.isArchived, false));

      const result = await db
        .select({
          id: schema.hives.id,
          apiaryId: schema.hives.apiaryId,
          positionLabel: schema.hives.positionLabel,
          status: schema.hives.status,
          isArchived: schema.hives.isArchived,
          deadoutDate: schema.hives.deadoutDate,
          installedDate: schema.hives.installedDate,
          notes: schema.hives.notes,
          createdAt: schema.hives.createdAt,
          apiaryName: schema.apiaries.name,
        })
        .from(schema.hives)
        .innerJoin(
          schema.apiaries,
          eq(schema.hives.apiaryId, schema.apiaries.id),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(schema.apiaries.name, schema.hives.positionLabel);

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "get_hive",
  "Get a single hive with full details including queen, recent inspections, and feedings",
  { id: z.string().describe("Hive UUID") },
  async ({ id }) => {
    try {
      const [hive] = await db
        .select()
        .from(schema.hives)
        .where(eq(schema.hives.id, id));
      if (!hive) return errorResult("Hive not found");

      const [apiary] = await db
        .select()
        .from(schema.apiaries)
        .where(eq(schema.apiaries.id, hive.apiaryId));

      const activeQueens = await db
        .select()
        .from(schema.queens)
        .where(
          and(
            eq(schema.queens.hiveId, id),
            eq(schema.queens.status, "active"),
          ),
        );

      const recentInspections = await db
        .select()
        .from(schema.inspections)
        .where(eq(schema.inspections.hiveId, id))
        .orderBy(desc(schema.inspections.date))
        .limit(5);

      const recentFeedings = await db
        .select()
        .from(schema.feedings)
        .where(eq(schema.feedings.hiveId, id))
        .orderBy(desc(schema.feedings.dateFed))
        .limit(5);

      return jsonResult({
        ...hive,
        apiary,
        activeQueens,
        recentInspections,
        recentFeedings,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "create_hive",
  "Create a new hive in an apiary",
  {
    apiaryId: z.string().describe("Apiary UUID to place the hive in"),
    positionLabel: z
      .string()
      .describe('Position label for the hive (e.g. "A1", "Stand 2 Left")'),
    status: z
      .enum(["active", "dead", "sold", "combined"])
      .optional()
      .describe("Hive status (default: active)"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ apiaryId, positionLabel, status, notes }) => {
    try {
      const [hive] = await db
        .insert(schema.hives)
        .values({
          apiaryId,
          positionLabel,
          status: status ?? "active",
          notes,
        })
        .returning();
      return jsonResult(hive);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "update_hive",
  "Update an existing hive",
  {
    id: z.string().describe("Hive UUID"),
    positionLabel: z.string().optional().describe("New position label"),
    status: z
      .enum(["active", "dead", "sold", "combined"])
      .optional()
      .describe("New status"),
    notes: z.string().optional().describe("New notes"),
    isArchived: z.boolean().optional().describe("Archive or unarchive the hive"),
  },
  async ({ id, ...updates }) => {
    try {
      const data: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.positionLabel !== undefined)
        data.positionLabel = updates.positionLabel;
      if (updates.status !== undefined) data.status = updates.status;
      if (updates.notes !== undefined) data.notes = updates.notes;
      if (updates.isArchived !== undefined)
        data.isArchived = updates.isArchived;

      const [hive] = await db
        .update(schema.hives)
        .set(data)
        .where(eq(schema.hives.id, id))
        .returning();
      if (!hive) return errorResult("Hive not found");
      return jsonResult(hive);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "archive_hive",
  "Archive a hive (soft-delete, keeps data but hides from active lists)",
  { id: z.string().describe("Hive UUID") },
  async ({ id }) => {
    try {
      const [hive] = await db
        .update(schema.hives)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(schema.hives.id, id))
        .returning();
      if (!hive) return errorResult("Hive not found");
      return jsonResult(hive);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "mark_deadout",
  "Mark a hive as dead-out with today's date",
  { id: z.string().describe("Hive UUID") },
  async ({ id }) => {
    try {
      const [hive] = await db
        .update(schema.hives)
        .set({
          status: "dead",
          deadoutDate: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.hives.id, id))
        .returning();
      if (!hive) return errorResult("Hive not found");
      return jsonResult(hive);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// QUEENS
// ============================================================

server.tool(
  "list_queens",
  "List all queens, optionally filtered by hive",
  {
    hiveId: z.string().optional().describe("Filter by hive UUID"),
  },
  async ({ hiveId }) => {
    try {
      const conditions = [];
      if (hiveId) conditions.push(eq(schema.queens.hiveId, hiveId));

      const result = await db
        .select({
          id: schema.queens.id,
          hiveId: schema.queens.hiveId,
          origin: schema.queens.origin,
          parentQueenId: schema.queens.parentQueenId,
          introducedDate: schema.queens.introducedDate,
          status: schema.queens.status,
          notes: schema.queens.notes,
          createdAt: schema.queens.createdAt,
        })
        .from(schema.queens)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.queens.createdAt));

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "create_queen",
  "Record a new queen",
  {
    hiveId: z.string().optional().describe("Hive UUID the queen is in"),
    origin: z
      .enum([
        "purchased",
        "swarm",
        "raised",
        "walked",
        "emergency_cell",
        "unknown",
      ])
      .describe("Origin/source of the queen"),
    parentQueenId: z.string().optional().describe("Parent queen UUID if known"),
    introducedDate: z
      .string()
      .optional()
      .describe("Date queen was introduced (ISO date string)"),
    status: z
      .enum(["active", "superseded", "dead", "missing"])
      .optional()
      .describe("Queen status (default: active)"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ hiveId, origin, parentQueenId, introducedDate, status, notes }) => {
    try {
      const [queen] = await db
        .insert(schema.queens)
        .values({
          hiveId,
          origin,
          parentQueenId,
          introducedDate: introducedDate
            ? new Date(introducedDate)
            : undefined,
          status: status ?? "active",
          notes,
        })
        .returning();
      return jsonResult(queen);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "update_queen",
  "Update a queen's status or notes",
  {
    id: z.string().describe("Queen UUID"),
    status: z
      .enum(["active", "superseded", "dead", "missing"])
      .optional()
      .describe("New status"),
    notes: z.string().optional().describe("New notes"),
  },
  async ({ id, ...updates }) => {
    try {
      const data: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.status !== undefined) data.status = updates.status;
      if (updates.notes !== undefined) data.notes = updates.notes;

      const [queen] = await db
        .update(schema.queens)
        .set(data)
        .where(eq(schema.queens.id, id))
        .returning();
      if (!queen) return errorResult("Queen not found");
      return jsonResult(queen);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// INSPECTIONS
// ============================================================

server.tool(
  "list_inspections",
  "List inspections, optionally filtered by hive. Returns most recent first.",
  {
    hiveId: z.string().optional().describe("Filter by hive UUID"),
    limit: z
      .number()
      .optional()
      .describe("Max number of inspections to return (default: 20)"),
  },
  async ({ hiveId, limit }) => {
    try {
      const conditions = [];
      if (hiveId) conditions.push(eq(schema.inspections.hiveId, hiveId));

      const result = await db
        .select({
          id: schema.inspections.id,
          hiveId: schema.inspections.hiveId,
          date: schema.inspections.date,
          queenSeen: schema.inspections.queenSeen,
          queenHealth: schema.inspections.queenHealth,
          broodPattern: schema.inspections.broodPattern,
          storesHoney: schema.inspections.storesHoney,
          storesPollen: schema.inspections.storesPollen,
          temperament: schema.inspections.temperament,
          pests: schema.inspections.pests,
          treatments: schema.inspections.treatments,
          notes: schema.inspections.notes,
          createdAt: schema.inspections.createdAt,
        })
        .from(schema.inspections)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.inspections.date))
        .limit(limit ?? 20);

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "create_inspection",
  "Record a new hive inspection",
  {
    hiveId: z.string().describe("Hive UUID"),
    date: z.string().describe("Inspection date (ISO date string)"),
    queenSeen: z.boolean().optional().describe("Was the queen seen?"),
    queenHealth: z.string().optional().describe("Queen health notes"),
    broodPattern: z.string().optional().describe("Brood pattern observations"),
    storesHoney: z
      .number()
      .optional()
      .describe("Honey stores rating (1-5 scale)"),
    storesPollen: z
      .number()
      .optional()
      .describe("Pollen stores rating (1-5 scale)"),
    temperament: z
      .number()
      .optional()
      .describe("Temperament rating (1-5 scale)"),
    notes: z.string().optional().describe("General inspection notes"),
  },
  async ({
    hiveId,
    date,
    queenSeen,
    queenHealth,
    broodPattern,
    storesHoney,
    storesPollen,
    temperament,
    notes,
  }) => {
    try {
      const [inspection] = await db
        .insert(schema.inspections)
        .values({
          hiveId,
          date: new Date(date),
          queenSeen,
          queenHealth,
          broodPattern,
          storesHoney,
          storesPollen,
          temperament,
          notes,
        })
        .returning();
      return jsonResult(inspection);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// FEEDINGS
// ============================================================

server.tool(
  "list_feedings",
  "List feedings for a hive, most recent first",
  {
    hiveId: z.string().describe("Hive UUID"),
  },
  async ({ hiveId }) => {
    try {
      const result = await db
        .select()
        .from(schema.feedings)
        .where(eq(schema.feedings.hiveId, hiveId))
        .orderBy(desc(schema.feedings.dateFed));

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "create_feeding",
  "Record a new feeding for a hive",
  {
    hiveId: z.string().describe("Hive UUID"),
    dateFed: z.string().describe("Date fed (ISO date string)"),
    type: z
      .enum([
        "sugar_syrup_1to1",
        "sugar_syrup_2to1",
        "dry_sugar",
        "pollen_patty",
        "fondant",
        "other",
      ])
      .describe("Type of feed"),
    quantity: z.number().describe("Quantity of feed"),
    quantityUnit: z
      .enum(["lbs", "oz", "quarts", "gallons"])
      .describe("Unit of measurement"),
    feederType: z
      .enum(["entrance", "top", "frame", "baggie", "bucket", "open", "other"])
      .optional()
      .describe("Type of feeder used"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ hiveId, dateFed, type, quantity, quantityUnit, feederType, notes }) => {
    try {
      const [feeding] = await db
        .insert(schema.feedings)
        .values({
          hiveId,
          dateFed: new Date(dateFed),
          type,
          quantity,
          quantityUnit,
          feederType,
          notes,
        })
        .returning();
      return jsonResult(feeding);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// HARVESTS
// ============================================================

server.tool(
  "list_harvests",
  "List honey harvests, optionally filtered by hive",
  {
    hiveId: z.string().optional().describe("Filter by hive UUID"),
  },
  async ({ hiveId }) => {
    try {
      const conditions = [];
      if (hiveId) conditions.push(eq(schema.honeyHarvests.hiveId, hiveId));

      const result = await db
        .select()
        .from(schema.honeyHarvests)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.honeyHarvests.date));

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "create_harvest",
  "Record a new honey harvest. Automatically calculates honey weight from super weights.",
  {
    hiveId: z.string().describe("Hive UUID"),
    date: z.string().describe("Harvest date (ISO date string)"),
    superWeightBefore: z
      .number()
      .describe("Weight of super before extraction (lbs)"),
    superWeightAfter: z
      .number()
      .describe("Weight of super after extraction (lbs)"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ hiveId, date, superWeightBefore, superWeightAfter, notes }) => {
    try {
      const calculatedHoneyWeight = superWeightBefore - superWeightAfter;

      const [harvest] = await db
        .insert(schema.honeyHarvests)
        .values({
          hiveId,
          date: new Date(date),
          superWeightBefore,
          superWeightAfter,
          calculatedHoneyWeight,
          notes,
        })
        .returning();
      return jsonResult(harvest);
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// EQUIPMENT (v2)
// ============================================================

server.tool(
  "list_equipment_stock",
  "List all equipment stock with type info and deployment counts",
  {},
  async () => {
    try {
      // Get stock with type info
      const stockRows = await db
        .select({
          id: schema.equipmentStock.id,
          typeId: schema.equipmentStock.typeId,
          totalOwned: schema.equipmentStock.totalOwned,
          frameCondition: schema.equipmentStock.frameCondition,
          storageLocation: schema.equipmentStock.storageLocation,
          notes: schema.equipmentStock.notes,
          typeName: schema.equipmentTypes.name,
          category: schema.equipmentTypes.category,
          framesPerBox: schema.equipmentTypes.framesPerBox,
        })
        .from(schema.equipmentStock)
        .innerJoin(
          schema.equipmentTypes,
          eq(schema.equipmentStock.typeId, schema.equipmentTypes.id),
        )
        .orderBy(schema.equipmentTypes.category, schema.equipmentTypes.name);

      // Get active deployment counts per stock item
      const deployCounts = await db
        .select({
          stockId: schema.equipmentDeployments.stockId,
          deployed: sql<number>`sum(${schema.equipmentDeployments.quantity})`,
        })
        .from(schema.equipmentDeployments)
        .where(isNull(schema.equipmentDeployments.dateRemoved))
        .groupBy(schema.equipmentDeployments.stockId);

      const deployMap = new Map(
        deployCounts.map((d) => [d.stockId, Number(d.deployed)]),
      );

      const result = stockRows.map((row) => ({
        ...row,
        deployed: deployMap.get(row.id) ?? 0,
        available: row.totalOwned - (deployMap.get(row.id) ?? 0),
      }));

      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "deploy_equipment",
  "Deploy equipment from stock to a hive",
  {
    stockId: z.string().describe("Equipment stock UUID"),
    hiveId: z.string().describe("Hive UUID to deploy to"),
    quantity: z.number().optional().describe("Quantity to deploy (default: 1)"),
    notes: z.string().optional().describe("Optional deployment notes"),
  },
  async ({ stockId, hiveId, quantity, notes }) => {
    try {
      const [deployment] = await db
        .insert(schema.equipmentDeployments)
        .values({
          stockId,
          hiveId,
          quantity: quantity ?? 1,
          dateDeployed: new Date(),
          notes,
        })
        .returning();
      return jsonResult(deployment);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "get_frame_summary",
  "Get a summary of frame tracking: total frames, deployed frames, and available frames by type",
  {},
  async () => {
    try {
      // Get frame-type equipment stocks
      const frameStocks = await db
        .select({
          id: schema.equipmentStock.id,
          totalOwned: schema.equipmentStock.totalOwned,
          frameCondition: schema.equipmentStock.frameCondition,
          typeName: schema.equipmentTypes.name,
          category: schema.equipmentTypes.category,
          framesPerBox: schema.equipmentTypes.framesPerBox,
        })
        .from(schema.equipmentStock)
        .innerJoin(
          schema.equipmentTypes,
          eq(schema.equipmentStock.typeId, schema.equipmentTypes.id),
        )
        .where(eq(schema.equipmentTypes.category, "frame"));

      // Active deployments for frame stocks
      const frameStockIds = frameStocks.map((f) => f.id);
      let deployments: Array<{
        stockId: string;
        deployed: number;
      }> = [];

      if (frameStockIds.length > 0) {
        deployments = await db
          .select({
            stockId: schema.equipmentDeployments.stockId,
            deployed:
              sql<number>`sum(${schema.equipmentDeployments.quantity})`,
          })
          .from(schema.equipmentDeployments)
          .where(
            and(
              isNull(schema.equipmentDeployments.dateRemoved),
              sql`${schema.equipmentDeployments.stockId} IN ${frameStockIds}`,
            ),
          )
          .groupBy(schema.equipmentDeployments.stockId);
      }

      const deployMap = new Map(
        deployments.map((d) => [d.stockId, Number(d.deployed)]),
      );

      const summary = frameStocks.map((stock) => ({
        typeName: stock.typeName,
        condition: stock.frameCondition,
        totalOwned: stock.totalOwned,
        deployed: deployMap.get(stock.id) ?? 0,
        available: stock.totalOwned - (deployMap.get(stock.id) ?? 0),
      }));

      const totals = {
        totalOwned: summary.reduce((s, r) => s + r.totalOwned, 0),
        totalDeployed: summary.reduce((s, r) => s + r.deployed, 0),
        totalAvailable: summary.reduce((s, r) => s + r.available, 0),
      };

      return jsonResult({ summary, totals });
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// DASHBOARD
// ============================================================

server.tool(
  "get_dashboard",
  "Get an overview dashboard with summary stats: total apiaries, active hives, recent inspections, and recent feedings",
  {},
  async () => {
    try {
      const [apiaryCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.apiaries);

      const [activeHiveCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.hives)
        .where(
          and(
            eq(schema.hives.isArchived, false),
            isNull(schema.hives.deadoutDate),
          ),
        );

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const [recentInspectionCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.inspections)
        .where(sql`${schema.inspections.date} >= ${thirtyDaysAgo}`);

      const recentInspections = await db
        .select({
          id: schema.inspections.id,
          hiveId: schema.inspections.hiveId,
          date: schema.inspections.date,
          notes: schema.inspections.notes,
          hiveLabel: schema.hives.positionLabel,
          apiaryName: schema.apiaries.name,
        })
        .from(schema.inspections)
        .innerJoin(
          schema.hives,
          eq(schema.inspections.hiveId, schema.hives.id),
        )
        .innerJoin(
          schema.apiaries,
          eq(schema.hives.apiaryId, schema.apiaries.id),
        )
        .orderBy(desc(schema.inspections.date))
        .limit(5);

      const recentFeedings = await db
        .select({
          id: schema.feedings.id,
          hiveId: schema.feedings.hiveId,
          dateFed: schema.feedings.dateFed,
          type: schema.feedings.type,
          quantity: schema.feedings.quantity,
          quantityUnit: schema.feedings.quantityUnit,
          hiveLabel: schema.hives.positionLabel,
          apiaryName: schema.apiaries.name,
        })
        .from(schema.feedings)
        .innerJoin(schema.hives, eq(schema.feedings.hiveId, schema.hives.id))
        .innerJoin(
          schema.apiaries,
          eq(schema.hives.apiaryId, schema.apiaries.id),
        )
        .orderBy(desc(schema.feedings.dateFed))
        .limit(5);

      // Hives by status
      const hivesByStatus = await db
        .select({
          status: schema.hives.status,
          count: sql<number>`count(*)`,
        })
        .from(schema.hives)
        .where(eq(schema.hives.isArchived, false))
        .groupBy(schema.hives.status);

      // Total honey harvested
      const [honeyTotal] = await db
        .select({
          totalWeight:
            sql<number>`coalesce(sum(${schema.honeyHarvests.calculatedHoneyWeight}), 0)`,
        })
        .from(schema.honeyHarvests);

      return jsonResult({
        totalApiaries: Number(apiaryCount.count),
        totalActiveHives: Number(activeHiveCount.count),
        recentInspectionsLast30Days: Number(recentInspectionCount.count),
        hivesByStatus: hivesByStatus.map((h) => ({
          status: h.status,
          count: Number(h.count),
        })),
        totalHoneyHarvestedLbs: Number(honeyTotal.totalWeight),
        recentInspections,
        recentFeedings,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

// ============================================================
// SERVER STARTUP
// ============================================================

export { server, db };

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Beez-Trackz MCP Server running on stdio");
}

// Only start the stdio transport when this file is the actual entrypoint
// (`npm run mcp`). A suffix check is not enough: Next.js standalone runs
// `node server.js`, which would otherwise match and start a second MCP
// server inside the web container.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
