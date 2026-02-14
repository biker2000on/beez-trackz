import { pgTable, uuid, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";

export const mediaOwnerTypeEnum = pgEnum("media_owner_type", ["hive", "apiary", "inspection"]);
export const transcriptionStatusEnum = pgEnum("transcription_status", ["pending", "processing", "complete", "failed"]);

export const photos = pgTable("photos", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerType: mediaOwnerTypeEnum("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  originalPath: text("original_path").notNull(),
  thumbnailPath: text("thumbnail_path"),
  mediumPath: text("medium_path"),
  takenDate: timestamp("taken_date"),
  caption: text("caption"),
  tags: jsonb("tags"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const mediaFiles = pgTable("media_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  originalUrl: text("original_url").notNull(),
  transcriptionText: text("transcription_text"),
  transcriptionStatus: transcriptionStatusEnum("transcription_status").default("pending").notNull(),
  ownerType: mediaOwnerTypeEnum("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
