import { pgTable, uuid, text, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const equipmentCategoryEnum = pgEnum("equipment_category", ["box", "cover", "bottom", "accessory", "frame", "other"]);
export const stockAdjustmentReasonEnum = pgEnum("stock_adjustment_reason", ["purchased", "built", "discarded", "broken", "gifted", "other"]);
export const frameConditionEnum = pgEnum("frame_condition", ["drawn", "fresh"]);

export const equipmentTypes = pgTable("equipment_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  category: equipmentCategoryEnum("category").notNull(),
  framesPerBox: integer("frames_per_box"),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const equipmentStock = pgTable("equipment_stock", {
  id: uuid("id").defaultRandom().primaryKey(),
  typeId: uuid("type_id").notNull().references(() => equipmentTypes.id),
  totalOwned: integer("total_owned").default(0).notNull(),
  frameCondition: frameConditionEnum("frame_condition"),
  storageLocation: text("storage_location"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const equipmentStockAdjustments = pgTable("equipment_stock_adjustments", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => equipmentStock.id),
  quantity: integer("quantity").notNull(),
  reason: stockAdjustmentReasonEnum("reason").notNull(),
  notes: text("notes"),
  date: timestamp("date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const equipmentDeployments = pgTable("equipment_deployments", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => equipmentStock.id),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  quantity: integer("quantity").default(1).notNull(),
  dateDeployed: timestamp("date_deployed").notNull(),
  dateRemoved: timestamp("date_removed"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
