import { pgTable, uuid, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const inspections = pgTable("inspections", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  date: timestamp("date").notNull(),
  inspectorName: text("inspector_name"),
  queenSeen: boolean("queen_seen"),
  queenHealth: text("queen_health"),
  broodPattern: text("brood_pattern"),
  storesHoney: integer("stores_honey"),
  storesPollen: integer("stores_pollen"),
  temperament: integer("temperament"),
  pests: jsonb("pests"),
  treatments: jsonb("treatments"),
  notes: text("notes"),
  sourceMedia: jsonb("source_media"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
