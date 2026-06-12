CREATE TYPE "public"."honey_movement_kind" AS ENUM('jarring', 'bulk_use', 'loss', 'give_away', 'jar_adjustment');--> statement-breakpoint
CREATE TABLE "honey_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" timestamp NOT NULL,
	"kind" "honey_movement_kind" NOT NULL,
	"amount_lbs" double precision,
	"jar_size_id" uuid,
	"quantity" integer,
	"reason" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honey_sale_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"jar_size_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jar_sizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"honey_oz" double precision,
	"default_price" double precision,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "jar_sizes_label_unique" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "honey_harvests" DROP CONSTRAINT "honey_harvests_equipment_id_equipment_id_fk";
--> statement-breakpoint
ALTER TABLE "honey_sales" ALTER COLUMN "items" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "honey_sales" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "honey_movements" ADD CONSTRAINT "honey_movements_jar_size_id_jar_sizes_id_fk" FOREIGN KEY ("jar_size_id") REFERENCES "public"."jar_sizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_sale_items" ADD CONSTRAINT "honey_sale_items_sale_id_honey_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."honey_sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_sale_items" ADD CONSTRAINT "honey_sale_items_jar_size_id_jar_sizes_id_fk" FOREIGN KEY ("jar_size_id") REFERENCES "public"."jar_sizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honey_harvests" DROP COLUMN "equipment_id";