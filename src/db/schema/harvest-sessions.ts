import { pgTable, uuid, text, timestamp, doublePrecision } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const harvestSessions = pgTable("harvest_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  date: timestamp("date").notNull(),
  totalExtractedWeight: doublePrecision("total_extracted_weight"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
