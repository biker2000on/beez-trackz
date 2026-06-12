import { pgTable, uuid, text, timestamp, doublePrecision, jsonb } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { harvestSessions } from "./harvest-sessions";

export const honeyHarvests = pgTable("honey_harvests", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => harvestSessions.id),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  date: timestamp("date").notNull(),
  superWeightBefore: doublePrecision("super_weight_before").notNull(),
  superWeightAfter: doublePrecision("super_weight_after").notNull(),
  calculatedHoneyWeight: doublePrecision("calculated_honey_weight").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const honeySales = pgTable("honey_sales", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: timestamp("date").notNull(),
  customerName: text("customer_name"),
  /** Where the sale happened (home, farmers market, shop name, …). */
  location: text("location"),
  /** Legacy line items; superseded by honey_sale_items, kept for history. */
  items: jsonb("items"),
  totalAmount: doublePrecision("total_amount").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

