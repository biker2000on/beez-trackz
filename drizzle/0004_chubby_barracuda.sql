CREATE TYPE "public"."hive_placement" AS ENUM('full', 'top', 'bottom', 'left', 'right');--> statement-breakpoint
ALTER TABLE "hives" ADD COLUMN "stand_id" text;--> statement-breakpoint
ALTER TABLE "hives" ADD COLUMN "slot_row" integer;--> statement-breakpoint
ALTER TABLE "hives" ADD COLUMN "slot_col" integer;--> statement-breakpoint
ALTER TABLE "hives" ADD COLUMN "placement" "hive_placement" DEFAULT 'full';