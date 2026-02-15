import { pgTable, uuid, text, timestamp, doublePrecision, pgEnum } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const feedTypeEnum = pgEnum("feed_type", ["sugar_syrup_1to1", "sugar_syrup_2to1", "dry_sugar", "pollen_patty", "fondant", "other"]);
export const feederTypeEnum = pgEnum("feeder_type", ["entrance", "top", "frame", "baggie", "bucket", "open", "other"]);
export const quantityUnitEnum = pgEnum("quantity_unit", ["lbs", "oz", "quarts", "gallons"]);

export const feedings = pgTable("feedings", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  dateFed: timestamp("date_fed").notNull(),
  type: feedTypeEnum("type").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  quantityUnit: quantityUnitEnum("quantity_unit").notNull(),
  feederType: feederTypeEnum("feeder_type"),
  dateEmpty: timestamp("date_empty"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
