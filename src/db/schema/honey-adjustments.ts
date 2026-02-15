import { pgTable, uuid, text, timestamp, doublePrecision, pgEnum } from "drizzle-orm/pg-core";

export const adjustmentTypeEnum = pgEnum("adjustment_type", ["jarring_loss", "other"]);

export const honeyAdjustments = pgTable("honey_adjustments", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: timestamp("date").notNull(),
  type: adjustmentTypeEnum("type").notNull(),
  amountLbs: doublePrecision("amount_lbs").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
