import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const userSettings = pgTable("user_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  aiProviderConfig: jsonb("ai_provider_config"),
  inspectionPreferences: jsonb("inspection_preferences"),
  jarSizes: jsonb("jar_sizes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
