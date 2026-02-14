import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const queenOriginEnum = pgEnum("queen_origin", ["purchased", "swarm", "raised", "walked", "emergency_cell", "unknown"]);
export const queenStatusEnum = pgEnum("queen_status", ["active", "superseded", "dead", "missing"]);

export const queens = pgTable("queens", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id),
  origin: queenOriginEnum("origin").notNull(),
  originHiveId: uuid("origin_hive_id").references(() => hives.id),
  parentQueenId: uuid("parent_queen_id"),
  introducedDate: timestamp("introduced_date"),
  status: queenStatusEnum("status").default("active").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
