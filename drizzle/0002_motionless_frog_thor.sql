CREATE TYPE "public"."adjustment_type" AS ENUM('jarring_loss', 'other');--> statement-breakpoint
CREATE TABLE "bloom_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apiary_id" uuid NOT NULL,
	"species" text NOT NULL,
	"date_first_seen" date NOT NULL,
	"date_last_seen" date,
	"year" integer NOT NULL,
	"abundance" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harvest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apiary_id" uuid NOT NULL,
	"date" timestamp NOT NULL,
	"total_extracted_weight" double precision,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honey_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" timestamp NOT NULL,
	"type" "adjustment_type" NOT NULL,
	"amount_lbs" double precision NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "honey_harvests" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "honey_harvests" ADD COLUMN "equipment_id" uuid;--> statement-breakpoint
ALTER TABLE "honey_inventory" ADD COLUMN "jar_size_label" text;--> statement-breakpoint
ALTER TABLE "honey_inventory" ADD COLUMN "honey_oz" double precision;--> statement-breakpoint
ALTER TABLE "bloom_observations" ADD CONSTRAINT "bloom_observations_apiary_id_apiaries_id_fk" FOREIGN KEY ("apiary_id") REFERENCES "public"."apiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harvest_sessions" ADD CONSTRAINT "harvest_sessions_apiary_id_apiaries_id_fk" FOREIGN KEY ("apiary_id") REFERENCES "public"."apiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_harvests" ADD CONSTRAINT "honey_harvests_session_id_harvest_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."harvest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_harvests" ADD CONSTRAINT "honey_harvests_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;