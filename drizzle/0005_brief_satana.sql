CREATE TYPE "public"."frame_condition" AS ENUM('drawn', 'fresh');--> statement-breakpoint
ALTER TYPE "public"."equipment_category" ADD VALUE 'frame' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "equipment_stock" ADD COLUMN "frame_condition" "frame_condition";--> statement-breakpoint
ALTER TABLE "equipment_types" ADD COLUMN "frames_per_box" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "oidc_issuer" text;