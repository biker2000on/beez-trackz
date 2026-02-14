import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { apiaries } from "./apiaries";

export const hiveLocationHistory = pgTable("hive_location_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  positionLabel: text("position_label").notNull(),
  dateFrom: timestamp("date_from").notNull(),
  dateTo: timestamp("date_to"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
