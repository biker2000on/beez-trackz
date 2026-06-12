-- Data migration: move legacy honey inventory / adjustments / sale items and
-- v1 equipment rows into the ledger-based tables before dropping the old
-- structures. All inserts are no-ops on empty databases.

-- 1) Jar sizes from the user_settings JSON price list
INSERT INTO "jar_sizes" ("label", "honey_oz", "sort_order")
SELECT t.elem->>'label', (t.elem->>'honeyOz')::double precision, t.ord - 1
FROM "user_settings",
     LATERAL jsonb_array_elements("user_settings"."jar_sizes") WITH ORDINALITY AS t(elem, ord)
WHERE "user_settings"."jar_sizes" IS NOT NULL
  AND jsonb_typeof("user_settings"."jar_sizes") = 'array'
  AND t.elem->>'label' IS NOT NULL
ON CONFLICT ("label") DO NOTHING;--> statement-breakpoint

-- 2) Jar sizes referenced by legacy inventory rows
INSERT INTO "jar_sizes" ("label", "honey_oz")
SELECT coalesce(nullif(hi."jar_size_label", ''), hi."jar_size"), max(hi."honey_oz")
FROM "honey_inventory" hi
GROUP BY 1
ON CONFLICT ("label") DO NOTHING;--> statement-breakpoint

-- 3) Jar sizes referenced by legacy sale line items
INSERT INTO "jar_sizes" ("label")
SELECT DISTINCT t.item->>'jarSize'
FROM "honey_sales" hs,
     LATERAL jsonb_array_elements(hs."items") AS t(item)
WHERE hs."items" IS NOT NULL
  AND jsonb_typeof(hs."items") = 'array'
  AND t.item->>'jarSize' IS NOT NULL
ON CONFLICT ("label") DO NOTHING;--> statement-breakpoint

-- 4) Legacy jar inventory rows become jarring movements
INSERT INTO "honey_movements" ("date", "kind", "amount_lbs", "jar_size_id", "quantity", "notes")
SELECT hi."created_at", 'jarring',
       (coalesce(hi."honey_oz", js."honey_oz") * hi."quantity") / 16.0,
       js."id", hi."quantity", 'migrated from legacy inventory'
FROM "honey_inventory" hi
JOIN "jar_sizes" js ON js."label" = coalesce(nullif(hi."jar_size_label", ''), hi."jar_size");--> statement-breakpoint

-- 5) Legacy adjustments become loss movements
INSERT INTO "honey_movements" ("date", "kind", "amount_lbs", "reason", "notes")
SELECT ha."date", 'loss', ha."amount_lbs",
       CASE WHEN ha."type" = 'jarring_loss' THEN 'jarring loss' ELSE coalesce(ha."reason", 'other') END,
       'migrated from honey_adjustments'
FROM "honey_adjustments" ha;--> statement-breakpoint

-- 6) Legacy sale JSONB items become normalized sale lines
INSERT INTO "honey_sale_items" ("sale_id", "jar_size_id", "quantity", "unit_price")
SELECT hs."id", js."id",
       coalesce((t.item->>'quantity')::int, 0),
       coalesce((t.item->>'pricePerUnit')::double precision, 0)
FROM "honey_sales" hs
CROSS JOIN LATERAL jsonb_array_elements(hs."items") AS t(item)
JOIN "jar_sizes" js ON js."label" = t.item->>'jarSize'
WHERE hs."items" IS NOT NULL
  AND jsonb_typeof(hs."items") = 'array'
  AND coalesce((t.item->>'quantity')::int, 0) > 0;--> statement-breakpoint

-- 7) v1 equipment rows: ensure a matching equipment type exists
INSERT INTO "equipment_types" ("name", "category", "is_default")
SELECT DISTINCT initcap(replace(e."type"::text, '_', ' ')),
       (CASE e."type"::text
          WHEN 'deep' THEN 'box'
          WHEN 'medium' THEN 'box'
          WHEN 'shallow' THEN 'box'
          WHEN 'inner_cover' THEN 'cover'
          WHEN 'outer_cover' THEN 'cover'
          WHEN 'bottom_board' THEN 'bottom'
          WHEN 'other' THEN 'other'
          ELSE 'accessory'
        END)::"equipment_category",
       false
FROM "equipment" e
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint

-- 8) v1 rows roll up into stock counts (one stock row per type)
INSERT INTO "equipment_stock" ("type_id", "total_owned", "notes")
SELECT et."id", count(*), 'migrated from legacy equipment'
FROM "equipment" e
JOIN "equipment_types" et ON et."name" = initcap(replace(e."type"::text, '_', ' '))
GROUP BY et."id";--> statement-breakpoint

-- 9) v1 rows currently on a hive become active deployments
INSERT INTO "equipment_deployments" ("stock_id", "hive_id", "quantity", "date_deployed", "notes")
SELECT es."id", e."hive_id", 1, coalesce(e."added_to_hive_date", e."created_at"), 'migrated from legacy equipment'
FROM "equipment" e
JOIN "equipment_types" et ON et."name" = initcap(replace(e."type"::text, '_', ' '))
JOIN LATERAL (
  SELECT id FROM "equipment_stock"
  WHERE "type_id" = et."id"
  ORDER BY "created_at" DESC
  LIMIT 1
) es ON true
WHERE e."hive_id" IS NOT NULL AND e."removed_from_hive_date" IS NULL;--> statement-breakpoint

DROP TABLE "equipment" CASCADE;--> statement-breakpoint
DROP TABLE "honey_adjustments" CASCADE;--> statement-breakpoint
DROP TABLE "honey_inventory" CASCADE;--> statement-breakpoint
DROP TYPE "public"."adjustment_type";--> statement-breakpoint
DROP TYPE "public"."equipment_type";--> statement-breakpoint
DROP TYPE "public"."frame_type";
