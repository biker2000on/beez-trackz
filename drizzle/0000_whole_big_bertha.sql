CREATE TYPE "public"."equipment_type" AS ENUM('deep', 'medium', 'shallow', 'queen_excluder', 'double_screen', 'inner_cover', 'outer_cover', 'bottom_board', 'entrance_reducer', 'feeder', 'other');--> statement-breakpoint
CREATE TYPE "public"."feed_type" AS ENUM('sugar_syrup_1to1', 'sugar_syrup_2to1', 'dry_sugar', 'pollen_patty', 'fondant', 'other');--> statement-breakpoint
CREATE TYPE "public"."feeder_type" AS ENUM('entrance', 'top', 'frame', 'baggie', 'open', 'other');--> statement-breakpoint
CREATE TYPE "public"."frame_type" AS ENUM('wax_foundation', 'plastic', 'foundationless', 'drawn_comb');--> statement-breakpoint
CREATE TYPE "public"."hive_status" AS ENUM('active', 'dead', 'sold', 'combined');--> statement-breakpoint
CREATE TYPE "public"."media_owner_type" AS ENUM('hive', 'apiary', 'inspection');--> statement-breakpoint
CREATE TYPE "public"."quantity_unit" AS ENUM('lbs', 'oz', 'quarts', 'gallons');--> statement-breakpoint
CREATE TYPE "public"."queen_origin" AS ENUM('purchased', 'swarm', 'raised', 'walked', 'emergency_cell', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."queen_status" AS ENUM('active', 'superseded', 'dead', 'missing');--> statement-breakpoint
CREATE TYPE "public"."recommendation_type" AS ENUM('inspection_due', 'treatment_reminder', 'equipment_needed', 'seasonal_prep', 'feeder_check');--> statement-breakpoint
CREATE TYPE "public"."transcription_status" AS ENUM('pending', 'processing', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "ai_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hive_id" uuid,
	"type" "recommendation_type" NOT NULL,
	"message" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apiaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"notes" text,
	"canvas_layout" jsonb,
	"satellite_image_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "equipment_type" NOT NULL,
	"frame_capacity" integer,
	"frames_installed" integer,
	"frame_type" "frame_type",
	"hive_id" uuid,
	"storage_location" text,
	"added_to_hive_date" timestamp,
	"removed_from_hive_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hive_id" uuid NOT NULL,
	"date_fed" timestamp NOT NULL,
	"type" "feed_type" NOT NULL,
	"quantity" double precision NOT NULL,
	"quantity_unit" "quantity_unit" NOT NULL,
	"feeder_type" "feeder_type",
	"date_empty" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hive_location_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hive_id" uuid NOT NULL,
	"apiary_id" uuid NOT NULL,
	"position_label" text NOT NULL,
	"date_from" timestamp NOT NULL,
	"date_to" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apiary_id" uuid NOT NULL,
	"position_label" text NOT NULL,
	"status" "hive_status" DEFAULT 'active' NOT NULL,
	"installed_date" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honey_harvests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hive_id" uuid NOT NULL,
	"date" timestamp NOT NULL,
	"super_weight_before" double precision NOT NULL,
	"super_weight_after" double precision NOT NULL,
	"calculated_honey_weight" double precision NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honey_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_size" text NOT NULL,
	"quantity" integer NOT NULL,
	"harvest_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honey_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" timestamp NOT NULL,
	"customer_name" text,
	"items" jsonb NOT NULL,
	"total_amount" double precision NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hive_id" uuid NOT NULL,
	"date" timestamp NOT NULL,
	"inspector_name" text,
	"queen_seen" boolean,
	"queen_health" text,
	"brood_pattern" text,
	"stores_honey" integer,
	"stores_pollen" integer,
	"temperament" integer,
	"pests" jsonb,
	"treatments" jsonb,
	"notes" text,
	"source_media" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_url" text NOT NULL,
	"transcription_text" text,
	"transcription_status" "transcription_status" DEFAULT 'pending' NOT NULL,
	"owner_type" "media_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "media_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"original_path" text NOT NULL,
	"thumbnail_path" text,
	"medium_path" text,
	"taken_date" timestamp,
	"caption" text,
	"tags" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hive_id" uuid,
	"origin" "queen_origin" NOT NULL,
	"origin_hive_id" uuid,
	"parent_queen_id" uuid,
	"introduced_date" timestamp,
	"status" "queen_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"ai_provider_config" jsonb,
	"inspection_preferences" jsonb,
	"jar_sizes" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedings" ADD CONSTRAINT "feedings_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive_location_history" ADD CONSTRAINT "hive_location_history_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive_location_history" ADD CONSTRAINT "hive_location_history_apiary_id_apiaries_id_fk" FOREIGN KEY ("apiary_id") REFERENCES "public"."apiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hives" ADD CONSTRAINT "hives_apiary_id_apiaries_id_fk" FOREIGN KEY ("apiary_id") REFERENCES "public"."apiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_harvests" ADD CONSTRAINT "honey_harvests_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_inventory" ADD CONSTRAINT "honey_inventory_harvest_id_honey_harvests_id_fk" FOREIGN KEY ("harvest_id") REFERENCES "public"."honey_harvests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queens" ADD CONSTRAINT "queens_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queens" ADD CONSTRAINT "queens_origin_hive_id_hives_id_fk" FOREIGN KEY ("origin_hive_id") REFERENCES "public"."hives"("id") ON DELETE no action ON UPDATE no action;