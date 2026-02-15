import { pgTable, uuid, text, timestamp, integer, date } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const bloomObservations = pgTable("bloom_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  species: text("species").notNull(),
  dateFirstSeen: date("date_first_seen").notNull(),
  dateLastSeen: date("date_last_seen"),
  year: integer("year").notNull(),
  abundance: integer("abundance"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
