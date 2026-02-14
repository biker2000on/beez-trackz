import { pgTable, uuid, text, timestamp, doublePrecision, integer, jsonb } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const honeyHarvests = pgTable("honey_harvests", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  date: timestamp("date").notNull(),
  superWeightBefore: doublePrecision("super_weight_before").notNull(),
  superWeightAfter: doublePrecision("super_weight_after").notNull(),
  calculatedHoneyWeight: doublePrecision("calculated_honey_weight").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const honeyInventory = pgTable("honey_inventory", {
  id: uuid("id").defaultRandom().primaryKey(),
  jarSize: text("jar_size").notNull(),
  quantity: integer("quantity").notNull(),
  harvestId: uuid("harvest_id").references(() => honeyHarvests.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const honeySales = pgTable("honey_sales", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: timestamp("date").notNull(),
  customerName: text("customer_name"),
  items: jsonb("items").notNull(),
  totalAmount: doublePrecision("total_amount").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
