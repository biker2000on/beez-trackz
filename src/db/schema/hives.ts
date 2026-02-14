import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const hiveStatusEnum = pgEnum("hive_status", ["active", "dead", "sold", "combined"]);

export const hives = pgTable("hives", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  positionLabel: text("position_label").notNull(),
  status: hiveStatusEnum("status").default("active").notNull(),
  installedDate: timestamp("installed_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
