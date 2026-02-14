import { pgTable, uuid, text, timestamp, jsonb, doublePrecision } from "drizzle-orm/pg-core";

export const apiaries = pgTable("apiaries", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  notes: text("notes"),
  canvasLayout: jsonb("canvas_layout"),
  satelliteImageUrl: text("satellite_image_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
