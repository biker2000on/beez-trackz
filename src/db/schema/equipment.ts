import { pgTable, uuid, text, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const equipmentTypeEnum = pgEnum("equipment_type", ["deep", "medium", "shallow", "queen_excluder", "double_screen", "inner_cover", "outer_cover", "bottom_board", "entrance_reducer", "feeder", "other"]);
export const frameTypeEnum = pgEnum("frame_type", ["wax_foundation", "plastic", "foundationless", "drawn_comb"]);

export const equipment = pgTable("equipment", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: equipmentTypeEnum("type").notNull(),
  frameCapacity: integer("frame_capacity"),
  framesInstalled: integer("frames_installed"),
  frameType: frameTypeEnum("frame_type"),
  hiveId: uuid("hive_id").references(() => hives.id),
  storageLocation: text("storage_location"),
  addedToHiveDate: timestamp("added_to_hive_date"),
  removedFromHiveDate: timestamp("removed_from_hive_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
