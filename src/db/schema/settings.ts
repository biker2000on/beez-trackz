import { pgTable, uuid, text, timestamp, jsonb, unique } from "drizzle-orm/pg-core";

export const userSettings = pgTable("user_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Null when the instance was bootstrapped via OIDC and no password
  // login has been configured.
  passwordHash: text("password_hash"),
  displayName: text("display_name"),
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

/**
 * OIDC identities known to this instance. Any account on the configured
 * provider may sign in (self-hosted, family-scoped IdP); each distinct
 * subject gets a row on first login. App data is instance-shared.
 */
export const oidcIdentities = pgTable(
  "oidc_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastLoginAt: timestamp("last_login_at").defaultNow().notNull(),
  },
  (table) => [unique("oidc_identities_issuer_subject").on(table.issuer, table.subject)]
);
