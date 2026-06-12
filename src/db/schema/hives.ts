import { pgTable, uuid, text, timestamp, pgEnum, boolean, integer } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const hiveStatusEnum = pgEnum("hive_status", ["active", "dead", "sold", "combined"]);
export const hivePlacementEnum = pgEnum("hive_placement", ["full", "top", "bottom", "left", "right"]);

export const hives = pgTable("hives", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  positionLabel: text("position_label").notNull(),
  standId: text("stand_id"),
  slotRow: integer("slot_row"),
  slotCol: integer("slot_col"),
  placement: hivePlacementEnum("placement").default("full"),
  facingDegrees: integer("facing_degrees").default(0),
  status: hiveStatusEnum("status").default("active").notNull(),
  installedDate: timestamp("installed_date"),
  isArchived: boolean("is_archived").default(false).notNull(),
  deadoutDate: timestamp("deadout_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
