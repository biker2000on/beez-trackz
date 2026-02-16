CREATE TYPE "public"."equipment_category" AS ENUM('box', 'cover', 'bottom', 'accessory', 'other');--> statement-breakpoint
CREATE TYPE "public"."split_type" AS ENUM('walk-away', 'vertical', 'nuc', 'cutdown', 'other');--> statement-breakpoint
CREATE TYPE "public"."stock_adjustment_reason" AS ENUM('purchased', 'built', 'discarded', 'broken', 'gifted', 'other');--> statement-breakpoint
CREATE TABLE "equipment_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_id" uuid NOT NULL,
	"hive_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"date_deployed" timestamp NOT NULL,
	"date_removed" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" uuid NOT NULL,
	"total_owned" integer DEFAULT 0 NOT NULL,
	"storage_location" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"reason" "stock_adjustment_reason" NOT NULL,
	"notes" text,
	"date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "equipment_category" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "hive_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_hive_id" uuid NOT NULL,
	"child_hive_id" uuid NOT NULL,
	"split_date" timestamp NOT NULL,
	"split_type" "split_type" NOT NULL,
	"frames_moved" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hives" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hives" ADD COLUMN "deadout_date" timestamp;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "theme" text DEFAULT 'system';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_apiary_id" uuid;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "date_format" text DEFAULT 'MM/DD/YYYY';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "weight_unit" text DEFAULT 'oz';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "dashboard_preferences" jsonb;--> statement-breakpoint
ALTER TABLE "equipment_deployments" ADD CONSTRAINT "equipment_deployments_stock_id_equipment_stock_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."equipment_stock"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_deployments" ADD CONSTRAINT "equipment_deployments_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_stock" ADD CONSTRAINT "equipment_stock_type_id_equipment_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."equipment_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_stock_adjustments" ADD CONSTRAINT "equipment_stock_adjustments_stock_id_equipment_stock_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."equipment_stock"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive_splits" ADD CONSTRAINT "hive_splits_parent_hive_id_hives_id_fk" FOREIGN KEY ("parent_hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive_splits" ADD CONSTRAINT "hive_splits_child_hive_id_hives_id_fk" FOREIGN KEY ("child_hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;