import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const userSettings = pgTable("user_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  oidcSubject: text("oidc_subject"),
  oidcIssuer: text("oidc_issuer"),
  aiProviderConfig: jsonb("ai_provider_config"),
  inspectionPreferences: jsonb("inspection_preferences"),
  jarSizes: jsonb("jar_sizes"),
  theme: text("theme").default("system"),
  defaultApiaryId: uuid("default_apiary_id"),
  dateFormat: text("date_format").default("MM/DD/YYYY"),
  weightUnit: text("weight_unit").default("oz"),
  dashboardPreferences: jsonb("dashboard_preferences"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
