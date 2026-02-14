import { pgTable, uuid, text, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const recommendationTypeEnum = pgEnum("recommendation_type", ["inspection_due", "treatment_reminder", "equipment_needed", "seasonal_prep", "feeder_check"]);

export const aiRecommendations = pgTable("ai_recommendations", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id),
  type: recommendationTypeEnum("type").notNull(),
  message: text("message").notNull(),
  priority: text("priority").default("normal").notNull(),
  dismissed: boolean("dismissed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
