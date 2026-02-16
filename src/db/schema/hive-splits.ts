import { pgTable, uuid, text, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const splitTypeEnum = pgEnum("split_type", ["walk-away", "vertical", "nuc", "cutdown", "other"]);

export const hiveSplits = pgTable("hive_splits", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentHiveId: uuid("parent_hive_id").notNull().references(() => hives.id),
  childHiveId: uuid("child_hive_id").notNull().references(() => hives.id),
  splitDate: timestamp("split_date").notNull(),
  splitType: splitTypeEnum("split_type").notNull(),
  framesMoved: integer("frames_moved"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
