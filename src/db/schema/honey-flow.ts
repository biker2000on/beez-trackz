import {
  pgTable,
  uuid,
  text,
  timestamp,
  doublePrecision,
  integer,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { honeySales } from "./honey";

/**
 * Honey flow ledger. Bulk honey (weight) comes in via harvest sessions and
 * leaves through movements; jars come into existence via `jarring` and
 * leave via sale items, `give_away`, or `jar_adjustment`. Inventory is
 * always derived by summing the ledger — rows are append-only, which keeps
 * the model simple, auditable, and bulk-editable.
 */

export const jarSizes = pgTable("jar_sizes", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: text("label").notNull().unique(),
  honeyOz: doublePrecision("honey_oz"),
  defaultPrice: doublePrecision("default_price"),
  sortOrder: integer("sort_order").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const honeyMovementKindEnum = pgEnum("honey_movement_kind", [
  "jarring", // bulk → jars (amountLbs derived from size × qty when size has oz)
  "bulk_use", // bulk consumed directly (mead, baking, …)
  "loss", // bulk written off (stickiness, cleaning, spills)
  "give_away", // jars given away or consumed at home
  "jar_adjustment", // manual jar count correction (+/-)
]);

export const honeyMovements = pgTable("honey_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: timestamp("date").notNull(),
  kind: honeyMovementKindEnum("kind").notNull(),
  /** Pounds of bulk honey consumed by this movement (bulk kinds + jarring). */
  amountLbs: doublePrecision("amount_lbs"),
  /** Jar movements: which size and how many (negative allowed for adjustments). */
  jarSizeId: uuid("jar_size_id").references(() => jarSizes.id),
  quantity: integer("quantity"),
  reason: text("reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Normalized sale lines (replaces the items JSONB on honey_sales). */
export const honeySaleItems = pgTable("honey_sale_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  saleId: uuid("sale_id")
    .notNull()
    .references(() => honeySales.id, { onDelete: "cascade" }),
  jarSizeId: uuid("jar_size_id")
    .notNull()
    .references(() => jarSizes.id),
  quantity: integer("quantity").notNull(),
  unitPrice: doublePrecision("unit_price").notNull(),
});
