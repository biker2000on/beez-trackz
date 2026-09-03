-- +goose Up
--
-- ledger-v1-baseline — the squashed initial schema (spec section 9, Phase B
-- step 6; decisions 9 and 10 of docs/plans/2026-09-01-inventory-ledger-design.md).
--
-- This one file replaces the 00001–00053 chain, which now lives unembedded
-- under backend/internal/db/legacy-00001-00052/ for reference only. It is the
-- post-00053 schema MINUS the ten legacy quantity tables and the five views
-- over them:
--
--   honey_movements, stock_movements, product_adjustments, equipment_stock,
--   equipment_stock_adjustments, equipment_deployments,
--   equipment_deployment_returns, equipment_state_changes, stock_locations,
--   equipment_type_components
--   + views honey_lot_balances, honey_varietal_balances,
--     equipment_stock_status, equipment_stock_reconciliation,
--     equipment_loss_events
--
-- Everything else is verbatim, columns included: a retained domain table here
-- has exactly the columns it had after 00053, so a Phase-A snapshot restores
-- into this schema without a column-level transform. Four foreign keys that
-- pointed INTO the dropped set are gone with them and their columns are now
-- unconstrained uuids (consignment_settlements.location_id,
-- sales.stock_location_id, external_sync.location_id,
-- sale_items.equipment_stock_id); re-keying those to inventory_locations /
-- inventory_items is application work, not schema work, and is tracked as
-- Phase B open items in docs/restore-runbook.md.
--
-- Seven trigger functions and four enum types became unreachable when their
-- only tables went away and are dropped with them:
-- equipment_component_cycle_guard, equipment_ledger_sync,
-- equipment_merge_duplicate_stock, equipment_stock_ledger_totals,
-- equipment_stock_reconcile_guard, equipment_stock_sync,
-- honey_movement_lot_matches_run; enums equipment_state, frame_condition,
-- honey_movement_kind, stock_adjustment_reason.
--
-- The Phase A freeze triggers (installed at runtime by app/backfill on the
-- eight legacy tables) have nothing to attach to here and are simply absent.
--
-- HOW THIS FILE WAS GENERATED — repeat this, do not hand-write the DDL:
--
--   1. Create a scratch database and migrate it through the whole legacy
--      chain (TEST_DATABASE_URL=... go test ./internal/db -run
--      TestMigrationsOnCleanPostgres, or goose up against
--      backend/internal/db/legacy-00001-00052).
--   2. Copy it (CREATE DATABASE carve TEMPLATE chain) and carve the copy:
--        DROP VIEW  ... the five views ... CASCADE;
--        DROP TABLE ... the ten tables ... CASCADE;
--        DROP FUNCTION ... the seven dead functions ...;
--        DROP TYPE ... the four dead enums ...;
--        DROP TABLE goose_db_version;  DELETE FROM schema_generation;
--   3. pg_dump -U beez -d carve --schema-only --no-owner --no-privileges
--   4. Strip the psql preamble (\restrict, the SET block, the search_path
--      set_config), wrap each CREATE FUNCTION in goose StatementBegin/End,
--      and prepend this header.
--   5. Append the seed block below: the registry/item/location seeds verbatim
--      from legacy 00050, the treatment-product catalog regenerated from the
--      scratch database (00019 as amended by 00034), and the generation stamp.
--
-- The information_schema equality between a baseline database and a
-- chain-migrated one is asserted by TestBaselineMatchesTheLegacyChain in
-- backend/internal/db; regenerate this file and re-run that test whenever the
-- legacy chain moves before the squash actually lands.

--
-- Name: apiary_access_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.apiary_access_role AS ENUM (
    'viewer',
    'editor'
);


--
-- Name: equipment_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.equipment_category AS ENUM (
    'box',
    'cover',
    'bottom',
    'accessory',
    'frame',
    'other',
    'packaging'
);


--
-- Name: feed_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.feed_type AS ENUM (
    'sugar_syrup_1to1',
    'sugar_syrup_2to1',
    'dry_sugar',
    'pollen_patty',
    'fondant',
    'other'
);


--
-- Name: feeder_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.feeder_type AS ENUM (
    'entrance',
    'top',
    'frame',
    'baggie',
    'bucket',
    'open',
    'other'
);


--
-- Name: feeding_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.feeding_state AS ENUM (
    'open',
    'closed',
    'unverified'
);


--
-- Name: hive_placement; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.hive_placement AS ENUM (
    'full',
    'top',
    'bottom',
    'left',
    'right'
);


--
-- Name: hive_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.hive_status AS ENUM (
    'active',
    'dead',
    'sold',
    'combined'
);


--
-- Name: media_owner_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.media_owner_type AS ENUM (
    'hive',
    'apiary',
    'inspection'
);


--
-- Name: photo_storage_backend; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.photo_storage_backend AS ENUM (
    'minio',
    'immich'
);


--
-- Name: quantity_unit; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.quantity_unit AS ENUM (
    'lbs',
    'oz',
    'quarts',
    'gallons'
);


--
-- Name: queen_origin; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.queen_origin AS ENUM (
    'purchased',
    'swarm',
    'raised',
    'walked',
    'emergency_cell',
    'unknown'
);


--
-- Name: queen_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.queen_status AS ENUM (
    'active',
    'superseded',
    'dead',
    'missing'
);


--
-- Name: recommendation_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.recommendation_type AS ENUM (
    'inspection_due',
    'treatment_reminder',
    'equipment_needed',
    'seasonal_prep',
    'feeder_check',
    'treat_now',
    'mite_check_due'
);


--
-- Name: split_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.split_type AS ENUM (
    'walk-away',
    'vertical',
    'nuc',
    'cutdown',
    'other'
);


--
-- Name: transcription_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transcription_status AS ENUM (
    'pending',
    'processing',
    'complete',
    'failed'
);


--
-- Name: inventory_hive_delete_guard(); Type: FUNCTION; Schema: public; Owner: -
--

-- +goose StatementBegin
CREATE FUNCTION public.inventory_hive_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_movements m
    WHERE m.container_hive_id = OLD.id
    GROUP BY m.item_id, m.location_id, m.lot_id, m.condition
    HAVING SUM(m.quantity) <> 0
  ) THEN
    RAISE EXCEPTION 'hive % has a nonzero deployed inventory balance', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_hive_delete_guard';
  END IF;
  RETURN OLD;
END;
$$;
-- +goose StatementEnd


--
-- Name: inventory_movement_scale_guard(); Type: FUNCTION; Schema: public; Owner: -
--

-- +goose StatementBegin
CREATE FUNCTION public.inventory_movement_scale_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item_scale smallint;
BEGIN
  SELECT quantity_scale INTO item_scale FROM inventory_items WHERE id = NEW.item_id;
  IF item_scale IS NOT NULL AND NEW.quantity <> trunc(NEW.quantity, item_scale) THEN
    RAISE EXCEPTION 'quantity % exceeds item quantity scale %', NEW.quantity, item_scale
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_movement_scale_guard';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

-- +goose StatementBegin
CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
-- +goose StatementEnd


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_recommendations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid,
    type public.recommendation_type NOT NULL,
    message text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    dismissed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    snoozed_until timestamp with time zone,
    dismissed_at timestamp with time zone,
    dismissed_by uuid
);


--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: apiaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apiaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    latitude double precision,
    longitude double precision,
    notes text,
    canvas_layout jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    elevation_m double precision,
    elevation_source text,
    forage_radius_m integer DEFAULT 2500 NOT NULL,
    CONSTRAINT apiaries_elevation_pair_check CHECK ((((elevation_m IS NULL) AND (elevation_source IS NULL)) OR ((elevation_m IS NOT NULL) AND (elevation_source IS NOT NULL)))),
    CONSTRAINT apiaries_elevation_source_check CHECK (((elevation_source IS NULL) OR (elevation_source = ANY (ARRAY['geolocation'::text, 'terrain'::text, 'override'::text])))),
    CONSTRAINT apiaries_forage_radius_m_check CHECK (((forage_radius_m >= 250) AND (forage_radius_m <= 8000)))
);


--
-- Name: apiary_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apiary_memberships (
    user_id uuid NOT NULL,
    apiary_id uuid NOT NULL,
    role public.apiary_access_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: apiary_weather_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apiary_weather_cache (
    apiary_id uuid NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    forecast jsonb NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_subject text,
    display_name text,
    email text,
    is_admin boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    password_hash text,
    username text
);


--
-- Name: bloom_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bloom_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    species text NOT NULL,
    date_first_seen date NOT NULL,
    date_last_seen date,
    year integer NOT NULL,
    abundance integer,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    elevation_m double precision,
    elevation_band text GENERATED ALWAYS AS (
CASE
    WHEN (elevation_m IS NULL) THEN NULL::text
    WHEN (elevation_m < (300)::double precision) THEN 'valley'::text
    WHEN (elevation_m < (700)::double precision) THEN 'foothill'::text
    WHEN (elevation_m < (1100)::double precision) THEN 'midslope'::text
    WHEN (elevation_m < (1600)::double precision) THEN 'ridge'::text
    ELSE 'summit'::text
END) STORED,
    CONSTRAINT bloom_observations_elevation_m_check CHECK (((elevation_m IS NULL) OR ((elevation_m >= ('-500'::integer)::double precision) AND (elevation_m <= (9000)::double precision))))
);


--
-- Name: bottling_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bottling_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lot_id uuid NOT NULL,
    bottled_date date NOT NULL,
    jar_size_id uuid,
    quantity integer NOT NULL,
    honey_lbs double precision,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    CONSTRAINT bottling_runs_honey_lbs_check CHECK (((honey_lbs IS NULL) OR (honey_lbs >= (0)::double precision))),
    CONSTRAINT bottling_runs_quantity_check CHECK ((quantity > 0))
);


--
-- Name: catch_boxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catch_boxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    location_kind text NOT NULL,
    stand_id text,
    fence_line text,
    date_set date NOT NULL,
    empty_as_of date,
    occupied boolean DEFAULT false NOT NULL,
    occupied_at date,
    occupied_hive_id uuid,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deletion_reason text,
    CONSTRAINT catch_boxes_location_fields CHECK ((((location_kind <> 'stand'::text) OR (stand_id IS NOT NULL)) AND ((location_kind <> 'fence_line'::text) OR (fence_line IS NOT NULL)))),
    CONSTRAINT catch_boxes_location_kind_check CHECK ((location_kind = ANY (ARRAY['yard'::text, 'stand'::text, 'fence_line'::text]))),
    CONSTRAINT catch_boxes_occupied_fields CHECK ((((occupied = false) AND (occupied_at IS NULL) AND (occupied_hive_id IS NULL)) OR ((occupied = true) AND (occupied_at IS NOT NULL))))
);


--
-- Name: colony_intakes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.colony_intakes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    apiary_id uuid NOT NULL,
    source text NOT NULL,
    source_detail text,
    source_hive_id uuid,
    catch_box_id uuid,
    intake_date date NOT NULL,
    starting_stores text,
    cost_cents bigint DEFAULT 0 NOT NULL,
    expense_id uuid NOT NULL,
    queen_id uuid,
    cohort_year integer NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT colony_intakes_cohort_year_check CHECK (((cohort_year >= 1900) AND (cohort_year <= 2200))),
    CONSTRAINT colony_intakes_cost_cents_check CHECK ((cost_cents >= 0)),
    CONSTRAINT colony_intakes_source_check CHECK ((source = ANY (ARRAY['package'::text, 'nuc'::text, 'split'::text, 'swarm'::text, 'catch_box'::text, 'other'::text])))
);


--
-- Name: consignment_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consignment_settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    location_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    reported_at timestamp with time zone NOT NULL,
    sale_id uuid,
    amount_owed_cents bigint DEFAULT 0 NOT NULL,
    amount_paid_cents bigint DEFAULT 0 NOT NULL,
    commission_cents bigint DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    CONSTRAINT consignment_settlements_amount_owed_cents_check CHECK ((amount_owed_cents >= 0)),
    CONSTRAINT consignment_settlements_amount_paid_cents_check CHECK ((amount_paid_cents >= 0)),
    CONSTRAINT consignment_settlements_commission_cents_check CHECK ((commission_cents >= 0)),
    CONSTRAINT consignment_settlements_paid_check CHECK ((amount_paid_cents <= amount_owed_cents)),
    CONSTRAINT consignment_settlements_period_check CHECK ((period_end >= period_start))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text,
    phone text,
    notes text,
    email_opt_in boolean DEFAULT false NOT NULL,
    referral_code text,
    referred_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: deadout_autopsies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deadout_autopsies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    autopsy_date date NOT NULL,
    stores_left text,
    cluster_position text,
    last_fall_mite_load numeric(8,2),
    queen_status text,
    moisture boolean,
    mold boolean,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deadout_autopsies_last_fall_mite_load_check CHECK (((last_fall_mite_load IS NULL) OR (last_fall_mite_load >= (0)::numeric))),
    CONSTRAINT deadout_autopsies_queen_status_check CHECK (((queen_status IS NULL) OR (queen_status = ANY (ARRAY['present'::text, 'absent'::text, 'unknown'::text]))))
);


--
-- Name: equipment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    category public.equipment_category NOT NULL,
    frames_per_box integer,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    variant_of_type_id uuid,
    item_id uuid,
    unit_cost_cents integer,
    needed_quantity integer,
    storage_location text,
    first_deployed_year integer,
    CONSTRAINT equipment_types_variant_not_self CHECK (((variant_of_type_id IS NULL) OR (variant_of_type_id <> id)))
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_date date NOT NULL,
    category text NOT NULL,
    description text NOT NULL,
    apiary_id uuid,
    hive_id uuid,
    harvest_lot_id uuid,
    season text,
    vendor text,
    quantity double precision,
    unit text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_cents bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deletion_reason text,
    CONSTRAINT expenses_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT expenses_category_check CHECK ((category = ANY (ARRAY['bees_queens'::text, 'feed'::text, 'treatments'::text, 'packaging'::text, 'equipment'::text, 'mileage'::text, 'market_fees'::text, 'labor'::text, 'other'::text, 'grocery'::text])))
);


--
-- Name: external_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_sync (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    system text DEFAULT 'gnucash_web'::text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    external_id text,
    account_mapping jsonb,
    category_mapping jsonb,
    tax_mapping jsonb,
    sync_state text DEFAULT 'pending'::text NOT NULL,
    conflict_state text,
    last_error text,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    location_id uuid,
    content_hash text,
    remote_transaction_guid text,
    remote_enter_date timestamp with time zone,
    CONSTRAINT external_sync_conflict_state_check CHECK (((conflict_state IS NULL) OR (conflict_state = ANY (ARRAY['none'::text, 'local_newer'::text, 'remote_newer'::text, 'diverged'::text])))),
    CONSTRAINT external_sync_entity_type_check CHECK ((entity_type = ANY (ARRAY['sale'::text, 'sale_item'::text, 'expense'::text, 'customer'::text, 'harvest_lot'::text, 'jar_size'::text, 'honey_movement'::text, 'bottling_run'::text, 'stock_location'::text, 'stock_movement'::text, 'consignment_settlement'::text, 'hive'::text, 'equipment_stock'::text, 'equipment_stock_adjustment'::text, 'product_catalog'::text, 'product_batch'::text, 'product_adjustment'::text]))),
    CONSTRAINT external_sync_sync_state_check CHECK ((sync_state = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'ignored'::text])))
);


--
-- Name: COLUMN external_sync.content_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.external_sync.content_hash IS 'Hash of the last pushed transaction body; a mismatch on rescan means local edits.';


--
-- Name: COLUMN external_sync.remote_enter_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.external_sync.remote_enter_date IS 'enterDate reported by the external system for the linked transaction.';


--
-- Name: feeding_status_backfills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feeding_status_backfills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feeding_id uuid NOT NULL,
    batch text NOT NULL,
    reason text NOT NULL,
    prior_status public.feeding_state NOT NULL,
    prior_date_empty timestamp with time zone,
    prior_closed_at timestamp with time zone,
    prior_closed_reason text,
    new_status public.feeding_state NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_by text DEFAULT 'migration 00007_feeding_lifecycle'::text NOT NULL,
    reverted_at timestamp with time zone
);


--
-- Name: feedings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    date_fed timestamp with time zone NOT NULL,
    type public.feed_type NOT NULL,
    quantity double precision NOT NULL,
    quantity_unit public.quantity_unit NOT NULL,
    feeder_type public.feeder_type,
    date_empty timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status public.feeding_state DEFAULT 'open'::public.feeding_state NOT NULL,
    closed_at timestamp with time zone,
    closed_reason text,
    refill_of_id uuid,
    status_changed_at timestamp with time zone,
    status_changed_by uuid,
    sale_id uuid,
    source_media_file_id uuid,
    source_transcript_version_id uuid,
    CONSTRAINT feedings_closed_state_ck CHECK (((status = 'closed'::public.feeding_state) = (closed_at IS NOT NULL)))
);


--
-- Name: field_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_incidents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    incident_type text NOT NULL,
    incident_date date NOT NULL,
    apiary_id uuid NOT NULL,
    hive_id uuid,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deletion_reason text,
    CONSTRAINT field_incidents_incident_type_check CHECK ((incident_type = ANY (ARRAY['robbing'::text, 'yellowjackets'::text, 'bears'::text, 'skunks'::text, 'flood'::text])))
);


--
-- Name: gnucash_sync_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gnucash_sync_settings (
    id boolean DEFAULT true NOT NULL,
    base_url text DEFAULT ''::text NOT NULL,
    api_token text,
    book_guid text,
    book_name text,
    root_currency text,
    changes_cursor text,
    sync_enabled boolean DEFAULT false NOT NULL,
    account_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    restore_state text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT gnucash_sync_settings_id_check CHECK (id),
    CONSTRAINT gnucash_sync_settings_restore_state_check CHECK ((restore_state = ANY (ARRAY['none'::text, 'installed'::text, 'reconciled'::text])))
);


--
-- Name: COLUMN gnucash_sync_settings.api_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gnucash_sync_settings.api_token IS 'folio personal access token (gcw_…). Never returned by the API.';


--
-- Name: COLUMN gnucash_sync_settings.changes_cursor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gnucash_sync_settings.changes_cursor IS 'Opaque cursor from GET changes. Persisted only after a page is processed.';


--
-- Name: COLUMN gnucash_sync_settings.restore_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gnucash_sync_settings.restore_state IS 'none | installed | reconciled. installed means a guarded snapshot restore is pending reconciliation and sync must stay disabled; only reconciled permits re-enabling sync afterwards.';


--
-- Name: harvest_lot_harvests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harvest_lot_harvests (
    lot_id uuid NOT NULL,
    harvest_id uuid NOT NULL
);


--
-- Name: harvest_lot_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harvest_lot_photos (
    lot_id uuid NOT NULL,
    photo_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: harvest_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harvest_lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lot_code text NOT NULL,
    public_slug text NOT NULL,
    extraction_date date NOT NULL,
    honey_weight_lbs double precision NOT NULL,
    honey_variety text,
    season text,
    apiary_region text,
    bloom_notes text,
    beekeeper_story text,
    testing_data jsonb,
    reorder_url text,
    is_public boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    moisture_pct double precision,
    bottling_moisture_pct double precision,
    honey_weight_entered text,
    claim_species text,
    claim_year integer,
    claim_apiary_id uuid,
    claim_elevation_m double precision,
    moisture_override_reason text,
    moisture_override_by uuid,
    moisture_override_at timestamp with time zone,
    honey_weight_source text DEFAULT 'manual'::text NOT NULL,
    varietal_id uuid,
    inventory_lot_id uuid,
    CONSTRAINT harvest_lots_bottling_moisture_pct_check CHECK (((bottling_moisture_pct IS NULL) OR ((bottling_moisture_pct >= (0)::double precision) AND (bottling_moisture_pct <= (100)::double precision)))),
    CONSTRAINT harvest_lots_claim_elevation_m_check CHECK (((claim_elevation_m IS NULL) OR ((claim_elevation_m >= ('-500'::integer)::double precision) AND (claim_elevation_m <= (9000)::double precision)))),
    CONSTRAINT harvest_lots_claim_year_check CHECK (((claim_year IS NULL) OR ((claim_year >= 1900) AND (claim_year <= 2100)))),
    CONSTRAINT harvest_lots_honey_weight_lbs_check CHECK ((honey_weight_lbs >= (0)::double precision)),
    CONSTRAINT harvest_lots_honey_weight_source_check CHECK ((honey_weight_source = ANY (ARRAY['manual'::text, 'derived'::text]))),
    CONSTRAINT harvest_lots_moisture_override_complete CHECK ((((moisture_override_reason IS NULL) AND (moisture_override_at IS NULL)) OR ((moisture_override_reason IS NOT NULL) AND (btrim(moisture_override_reason) <> ''::text) AND (moisture_override_at IS NOT NULL)))),
    CONSTRAINT harvest_lots_moisture_pct_check CHECK (((moisture_pct IS NULL) OR ((moisture_pct >= (0)::double precision) AND (moisture_pct <= (100)::double precision))))
);


--
-- Name: COLUMN harvest_lots.claim_species; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.harvest_lots.claim_species IS 'Declared floral source: species or free label (e.g. Sourwood). Shared by lot, label, and Honey Story.';


--
-- Name: COLUMN harvest_lots.claim_year; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.harvest_lots.claim_year IS 'Harvest year of the declared floral source.';


--
-- Name: COLUMN harvest_lots.claim_apiary_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.harvest_lots.claim_apiary_id IS 'Yard named on the floral claim (e.g. Yard B).';


--
-- Name: COLUMN harvest_lots.claim_elevation_m; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.harvest_lots.claim_elevation_m IS 'Elevation of the claimed source in meters. Display converts to feet when the operator prefers US units.';


--
-- Name: COLUMN harvest_lots.moisture_override_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.harvest_lots.moisture_override_reason IS 'Why an over-threshold moisture reading was accepted. NULL = no override; the reading was within threshold or the lot was refused.';


--
-- Name: harvest_session_true_ups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harvest_session_true_ups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    previous_weight_lbs double precision,
    new_weight_lbs double precision NOT NULL,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT harvest_session_true_ups_new_weight_lbs_check CHECK ((new_weight_lbs >= (0)::double precision))
);


--
-- Name: harvest_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harvest_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    date timestamp with time zone NOT NULL,
    total_extracted_weight double precision,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    moisture_pct double precision,
    CONSTRAINT harvest_sessions_moisture_pct_check CHECK (((moisture_pct IS NULL) OR ((moisture_pct >= (0)::double precision) AND (moisture_pct <= (100)::double precision))))
);


--
-- Name: hive_location_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hive_location_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    apiary_id uuid NOT NULL,
    position_label text NOT NULL,
    date_from timestamp with time zone NOT NULL,
    date_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hive_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hive_splits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_hive_id uuid NOT NULL,
    child_hive_id uuid NOT NULL,
    split_date timestamp with time zone NOT NULL,
    split_type public.split_type NOT NULL,
    frames_moved integer,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    position_label text NOT NULL,
    stand_id text,
    slot_row integer,
    slot_col integer,
    placement public.hive_placement DEFAULT 'full'::public.hive_placement,
    facing_degrees integer DEFAULT 0,
    status public.hive_status DEFAULT 'active'::public.hive_status NOT NULL,
    installed_date timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    deadout_date timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sale_id uuid,
    latitude double precision,
    longitude double precision,
    gps_source text,
    CONSTRAINT hives_gps_source_check CHECK (((gps_source IS NULL) OR (gps_source = ANY (ARRAY['layout'::text, 'manual'::text]))))
);


--
-- Name: honey_harvests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.honey_harvests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    hive_id uuid NOT NULL,
    date timestamp with time zone NOT NULL,
    super_weight_before double precision NOT NULL,
    super_weight_after double precision NOT NULL,
    calculated_honey_weight double precision NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    deletion_reason text,
    direct_weight boolean DEFAULT false NOT NULL
);


--
-- Name: honey_varietals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.honey_varietals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: immich_timeline_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.immich_timeline_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    immich_asset_id text NOT NULL,
    original_filename text,
    taken_date timestamp with time zone,
    latitude double precision,
    longitude double precision,
    matched_terms text[] DEFAULT '{}'::text[] NOT NULL,
    nearby_apiary_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    review_state text DEFAULT 'pending'::text NOT NULL,
    review_reason text NOT NULL,
    auto_adopted boolean DEFAULT false NOT NULL,
    photo_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_scan_id uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT immich_timeline_candidates_check CHECK (((latitude IS NULL) = (longitude IS NULL))),
    CONSTRAINT immich_timeline_candidates_latitude_check CHECK (((latitude IS NULL) OR ((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision)))),
    CONSTRAINT immich_timeline_candidates_longitude_check CHECK (((longitude IS NULL) OR ((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision)))),
    CONSTRAINT immich_timeline_candidates_review_state_check CHECK ((review_state = ANY (ARRAY['pending'::text, 'adopted'::text, 'rejected'::text])))
);


--
-- Name: immich_timeline_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.immich_timeline_scans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    task_id text,
    attempts integer DEFAULT 0 NOT NULL,
    matched_count integer DEFAULT 0 NOT NULL,
    adopted_count integer DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    error text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT immich_timeline_scans_adopted_count_check CHECK ((adopted_count >= 0)),
    CONSTRAINT immich_timeline_scans_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT immich_timeline_scans_matched_count_check CHECK ((matched_count >= 0)),
    CONSTRAINT immich_timeline_scans_review_count_check CHECK ((review_count >= 0)),
    CONSTRAINT immich_timeline_scans_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inspections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    date timestamp with time zone NOT NULL,
    inspector_name text,
    queen_seen boolean,
    queen_health text,
    brood_pattern text,
    stores_honey integer,
    stores_pollen integer,
    temperament integer,
    pests jsonb,
    treatments jsonb,
    notes text,
    source_media jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    weather_snapshot jsonb,
    source_media_file_id uuid,
    source_transcript_version_id uuid,
    frames_of_bees integer,
    frames_of_brood integer,
    frames_of_stores integer,
    crowded_brood boolean,
    queen_cups_count integer,
    queen_cells_count integer,
    flow_on boolean,
    CONSTRAINT inspections_frames_of_bees_check CHECK (((frames_of_bees IS NULL) OR (frames_of_bees >= 0))),
    CONSTRAINT inspections_frames_of_brood_check CHECK (((frames_of_brood IS NULL) OR (frames_of_brood >= 0))),
    CONSTRAINT inspections_frames_of_stores_check CHECK (((frames_of_stores IS NULL) OR (frames_of_stores >= 0))),
    CONSTRAINT inspections_queen_cells_count_check CHECK (((queen_cells_count IS NULL) OR (queen_cells_count >= 0))),
    CONSTRAINT inspections_queen_cups_count_check CHECK (((queen_cups_count IS NULL) OR (queen_cups_count >= 0)))
);


--
-- Name: inventory_balances; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.inventory_balances AS
SELECT
    NULL::uuid AS item_id,
    NULL::uuid AS location_id,
    NULL::uuid AS lot_id,
    NULL::text AS condition,
    NULL::uuid AS container_hive_id,
    NULL::numeric AS on_hand;


--
-- Name: inventory_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    parent_id uuid,
    is_home boolean DEFAULT false NOT NULL,
    source_type text,
    source_id uuid,
    is_consignment boolean DEFAULT false NOT NULL,
    price_basis text DEFAULT 'retail'::text NOT NULL,
    commission_bps integer,
    wholesale_price_list_id uuid,
    settlement_cadence text DEFAULT 'monthly'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT inventory_locations_basis_check CHECK ((((price_basis = 'commission'::text) AND (commission_bps IS NOT NULL)) OR ((price_basis = 'wholesale_list'::text) AND (wholesale_price_list_id IS NOT NULL)) OR (price_basis = 'retail'::text))),
    CONSTRAINT inventory_locations_commission_bps_check CHECK (((commission_bps IS NULL) OR ((commission_bps >= 0) AND (commission_bps <= 10000)))),
    CONSTRAINT inventory_locations_home_check CHECK (((NOT is_home) OR ((NOT is_consignment) AND (source_type IS NULL) AND (price_basis = 'retail'::text)))),
    CONSTRAINT inventory_locations_price_basis_check CHECK ((price_basis = ANY (ARRAY['retail'::text, 'commission'::text, 'wholesale_list'::text]))),
    CONSTRAINT inventory_locations_settlement_cadence_check CHECK ((settlement_cadence = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'quarterly'::text, 'on_request'::text]))),
    CONSTRAINT inventory_locations_source_pair CHECK (((source_type IS NULL) = (source_id IS NULL)))
);


--
-- Name: product_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    unit text NOT NULL,
    default_price_cents bigint NOT NULL,
    size_label text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    net_grams double precision,
    item_id uuid,
    CONSTRAINT product_catalog_default_price_cents_check CHECK ((default_price_cents >= 0)),
    CONSTRAINT product_catalog_kind_check CHECK ((kind = ANY (ARRAY['creamed_honey'::text, 'hot_honey'::text, 'mead'::text, 'propolis'::text, 'tincture'::text]))),
    CONSTRAINT product_catalog_net_grams_check CHECK (((net_grams IS NULL) OR (net_grams > (0)::double precision)))
);


--
-- Name: COLUMN product_catalog.net_grams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_catalog.net_grams IS 'Net propolis grams per unit sold. Required for kind=propolis so sales decrement the harvest ledger; optional otherwise.';


--
-- Name: sale_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    jar_size_id uuid,
    quantity integer NOT NULL,
    unit_price_cents bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    kind text DEFAULT 'jar'::text NOT NULL,
    hive_id uuid,
    equipment_stock_id uuid,
    product_id uuid,
    bottling_run_id uuid,
    cost_basis_cents bigint,
    item_id uuid,
    inventory_lot_id uuid,
    CONSTRAINT honey_sale_items_unit_price_cents_check CHECK ((unit_price_cents >= 0)),
    CONSTRAINT sale_items_bottling_run_jar_only CHECK (((bottling_run_id IS NULL) OR (kind = 'jar'::text))),
    CONSTRAINT sale_items_cost_basis_cents_check CHECK (((cost_basis_cents IS NULL) OR (cost_basis_cents >= 0))),
    CONSTRAINT sale_items_kind_check CHECK ((kind = ANY (ARRAY['jar'::text, 'colony'::text, 'equipment'::text, 'creamed_honey'::text, 'hot_honey'::text, 'mead'::text, 'propolis'::text, 'tincture'::text]))),
    CONSTRAINT sale_items_target_check CHECK ((((kind = 'jar'::text) AND (jar_size_id IS NOT NULL) AND (hive_id IS NULL) AND (equipment_stock_id IS NULL) AND (product_id IS NULL)) OR ((kind = 'colony'::text) AND (hive_id IS NOT NULL) AND (jar_size_id IS NULL) AND (equipment_stock_id IS NULL) AND (product_id IS NULL)) OR ((kind = 'equipment'::text) AND ((item_id IS NOT NULL) OR (equipment_stock_id IS NOT NULL)) AND (jar_size_id IS NULL) AND (hive_id IS NULL) AND (product_id IS NULL)) OR ((kind = ANY (ARRAY['creamed_honey'::text, 'hot_honey'::text, 'mead'::text, 'propolis'::text, 'tincture'::text])) AND (product_id IS NOT NULL) AND (jar_size_id IS NULL) AND (hive_id IS NULL) AND (equipment_stock_id IS NULL))))
);


--
-- Name: COLUMN sale_items.cost_basis_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sale_items.cost_basis_cents IS 'COGS frozen at physical apply. Equipment: quantity * unit_cost_cents_snapshot. Colony: SUM of live bees_queens expenses for the hive. NULL = no recorded basis.';


--
-- Name: sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date timestamp with time zone NOT NULL,
    customer_name text,
    location text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    customer_id uuid,
    harvest_lot_id uuid,
    channel text DEFAULT 'direct'::text NOT NULL,
    payment_method text DEFAULT 'cash'::text NOT NULL,
    order_status text DEFAULT 'paid'::text NOT NULL,
    order_number text,
    due_date date,
    wholesale_price_list_id uuid,
    total_amount_cents bigint NOT NULL,
    discount_amount_cents bigint DEFAULT 0 NOT NULL,
    amount_paid_cents bigint DEFAULT 0 NOT NULL,
    tax_cents bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancellation_reason text,
    physical_applied_at timestamp with time zone,
    stock_location_id uuid,
    CONSTRAINT honey_sales_amount_paid_cents_check CHECK ((amount_paid_cents >= 0)),
    CONSTRAINT honey_sales_channel_check CHECK ((channel = ANY (ARRAY['farm_stand'::text, 'farmers_market'::text, 'wholesale'::text, 'pickup'::text, 'online'::text, 'gift'::text, 'consignment'::text, 'direct'::text]))),
    CONSTRAINT honey_sales_discount_amount_cents_check CHECK ((discount_amount_cents >= 0)),
    CONSTRAINT honey_sales_order_status_check CHECK ((order_status = ANY (ARRAY['draft'::text, 'pending'::text, 'paid'::text, 'fulfilled'::text, 'cancelled'::text]))),
    CONSTRAINT honey_sales_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'card'::text, 'check'::text, 'venmo'::text, 'paypal'::text, 'invoice'::text, 'other'::text]))),
    CONSTRAINT honey_sales_tax_cents_check CHECK (((tax_cents IS NULL) OR (tax_cents >= 0)))
);


--
-- Name: COLUMN sales.stock_location_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sales.stock_location_id IS 'Location the sold stock came off. NULL = home.';


--
-- Name: inventory_reservations; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.inventory_reservations AS
 SELECT
        CASE
            WHEN (si.kind = 'propolis'::text) THEN '00000000-0000-0000-0000-000000000102'::uuid
            ELSE si.item_id
        END AS item_id,
        CASE
            WHEN (si.hive_id IS NOT NULL) THEN deployed.id
            ELSE COALESCE(mapped.id, home.id)
        END AS location_id,
    si.inventory_lot_id AS lot_id,
    NULL::text AS condition,
    si.hive_id AS container_hive_id,
    (sum(
        CASE
            WHEN (si.kind = 'propolis'::text) THEN ((si.quantity)::double precision * COALESCE(pc.net_grams, (1)::double precision))
            ELSE (si.quantity)::double precision
        END))::numeric(14,4) AS reserved
   FROM (((((public.sale_items si
     JOIN public.sales s ON ((s.id = si.sale_id)))
     CROSS JOIN ( SELECT inventory_locations.id
           FROM public.inventory_locations
          WHERE inventory_locations.is_home) home)
     CROSS JOIN ( SELECT inventory_locations.id
           FROM public.inventory_locations
          WHERE (inventory_locations.kind = 'deployed'::text)) deployed)
     LEFT JOIN public.inventory_locations mapped ON (((mapped.source_type = 'stock_location'::text) AND (mapped.source_id = s.stock_location_id))))
     LEFT JOIN public.product_catalog pc ON ((pc.id = si.product_id)))
  WHERE ((s.physical_applied_at IS NULL) AND (s.order_status <> 'cancelled'::text) AND ((si.item_id IS NOT NULL) OR (si.kind = 'propolis'::text)))
  GROUP BY
        CASE
            WHEN (si.kind = 'propolis'::text) THEN '00000000-0000-0000-0000-000000000102'::uuid
            ELSE si.item_id
        END,
        CASE
            WHEN (si.hive_id IS NOT NULL) THEN deployed.id
            ELSE COALESCE(mapped.id, home.id)
        END, si.inventory_lot_id, NULL::text, si.hive_id;


--
-- Name: inventory_available; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.inventory_available AS
 WITH keys AS (
         SELECT inventory_balances.item_id,
            inventory_balances.location_id,
            inventory_balances.lot_id,
            inventory_balances.condition,
            inventory_balances.container_hive_id
           FROM public.inventory_balances
        UNION
         SELECT inventory_reservations.item_id,
            inventory_reservations.location_id,
            inventory_reservations.lot_id,
            inventory_reservations.condition,
            inventory_reservations.container_hive_id
           FROM public.inventory_reservations
        )
 SELECT k.item_id,
    k.location_id,
    k.lot_id,
    k.condition,
    k.container_hive_id,
    (COALESCE(b.on_hand, (0)::numeric))::numeric(14,4) AS on_hand,
    (COALESCE(r.reserved, (0)::numeric))::numeric(14,4) AS reserved,
    ((COALESCE(b.on_hand, (0)::numeric) - COALESCE(r.reserved, (0)::numeric)))::numeric(14,4) AS available
   FROM ((keys k
     LEFT JOIN public.inventory_balances b ON (((b.item_id = k.item_id) AND (b.location_id = k.location_id) AND (NOT (b.lot_id IS DISTINCT FROM k.lot_id)) AND (NOT (b.condition IS DISTINCT FROM k.condition)) AND (NOT (b.container_hive_id IS DISTINCT FROM k.container_hive_id)))))
     LEFT JOIN public.inventory_reservations r ON (((r.item_id = k.item_id) AND (r.location_id = k.location_id) AND (NOT (r.lot_id IS DISTINCT FROM k.lot_id)) AND (NOT (r.condition IS DISTINCT FROM k.condition)) AND (NOT (r.container_hive_id IS DISTINCT FROM k.container_hive_id)))));


--
-- Name: inventory_balance_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_balance_checkpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    lot_id uuid,
    condition text,
    container_hive_id uuid,
    as_of_operation_id uuid NOT NULL,
    on_hand numeric(14,4) NOT NULL,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: inventory_bom_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_bom_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bom_id uuid NOT NULL,
    role text NOT NULL,
    item_id uuid NOT NULL,
    quantity numeric(14,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT inventory_bom_lines_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT inventory_bom_lines_role_check CHECK ((role = ANY (ARRAY['input'::text, 'output'::text, 'byproduct'::text, 'waste'::text])))
);


--
-- Name: inventory_boms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_boms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    output_item_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: inventory_conditions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_conditions (
    condition text NOT NULL,
    description text NOT NULL,
    sellable boolean NOT NULL
);


--
-- Name: inventory_item_kinds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_item_kinds (
    kind text NOT NULL,
    description text NOT NULL,
    unit_family text NOT NULL
);


--
-- Name: inventory_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    canonical_unit text NOT NULL,
    quantity_scale smallint NOT NULL,
    lot_tracked boolean NOT NULL,
    condition_tracked boolean NOT NULL,
    container_tracked boolean NOT NULL,
    source_type text,
    source_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT inventory_items_quantity_scale_check CHECK (((quantity_scale >= 0) AND (quantity_scale <= 4))),
    CONSTRAINT inventory_items_source_pair CHECK (((source_type IS NULL) = (source_id IS NULL)))
);


--
-- Name: inventory_location_kinds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_location_kinds (
    kind text NOT NULL,
    description text NOT NULL
);


--
-- Name: inventory_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    code text NOT NULL,
    source_type text,
    source_id uuid,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_legacy_unassigned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT inventory_lots_source_pair CHECK (((source_type IS NULL) = (source_id IS NULL)))
);


--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    line_no smallint NOT NULL,
    item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    lot_id uuid,
    condition text,
    container_hive_id uuid,
    quantity numeric(14,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT inventory_movements_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT inventory_movements_quantity_check CHECK ((quantity <> (0)::numeric))
);


--
-- Name: inventory_operation_kinds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_operation_kinds (
    kind text NOT NULL,
    description text NOT NULL,
    sided text NOT NULL,
    CONSTRAINT inventory_operation_kinds_sided_check CHECK ((sided = ANY (ARRAY['one'::text, 'paired'::text, 'transform'::text])))
);


--
-- Name: inventory_operation_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_operation_reasons (
    reason text NOT NULL,
    description text NOT NULL,
    applies_to_kinds text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: inventory_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_operations (
    id uuid NOT NULL,
    kind text NOT NULL,
    reason text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    idempotency_key text NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    reverses_operation_id uuid,
    legacy_ref_type text,
    legacy_ref_id uuid,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    provenance text DEFAULT 'recorded'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT inventory_operations_legacy_ref_pair CHECK (((legacy_ref_type IS NULL) = (legacy_ref_id IS NULL))),
    CONSTRAINT inventory_operations_provenance_check CHECK ((provenance = ANY (ARRAY['recorded'::text, 'legacy-import'::text, 'legacy-unattributed'::text])))
);


--
-- Name: jar_serials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jar_serials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bottling_run_id uuid NOT NULL,
    serial_number text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sale_id uuid,
    sold_at timestamp with time zone,
    linked_by uuid,
    CONSTRAINT jar_serials_sale_link_ck CHECK (((sale_id IS NULL) = (sold_at IS NULL)))
);


--
-- Name: jar_sizes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jar_sizes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL,
    honey_oz double precision,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    low_stock_threshold integer DEFAULT 6 NOT NULL,
    default_price_cents bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    packaging_type_id uuid,
    item_id uuid,
    CONSTRAINT jar_sizes_default_price_cents_check CHECK (((default_price_cents IS NULL) OR (default_price_cents >= 0))),
    CONSTRAINT jar_sizes_low_stock_threshold_check CHECK ((low_stock_threshold >= 0))
);


--
-- Name: COLUMN jar_sizes.packaging_type_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jar_sizes.packaging_type_id IS 'Equipment type holding the empty containers for this size. Jarring consumes one per jar and warns, never blocks, when stock runs short.';


--
-- Name: media_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    audio_key text NOT NULL,
    transcription_text text,
    transcription_status public.transcription_status DEFAULT 'pending'::public.transcription_status NOT NULL,
    transcription_error text,
    owner_type public.media_owner_type NOT NULL,
    owner_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_transcript_version_id uuid,
    retranscription_requested_at timestamp with time zone
);


--
-- Name: mite_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mite_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    inspection_id uuid,
    date timestamp with time zone NOT NULL,
    method text NOT NULL,
    mites_count integer NOT NULL,
    sample_size integer,
    mites_per_100 double precision GENERATED ALWAYS AS (
CASE
    WHEN (sample_size IS NOT NULL) THEN (((mites_count)::double precision * (100.0)::double precision) / (sample_size)::double precision)
    ELSE NULL::double precision
END) STORED,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    days_on_board integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mites_per_day double precision GENERATED ALWAYS AS (
CASE
    WHEN ((method = ANY (ARRAY['sticky_board'::text, 'visual'::text])) AND (days_on_board IS NOT NULL)) THEN ((mites_count)::double precision / (days_on_board)::double precision)
    ELSE NULL::double precision
END) STORED,
    source_media_file_id uuid,
    source_transcript_version_id uuid,
    created_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT mite_counts_days_on_board_check CHECK (((days_on_board IS NULL) OR (days_on_board > 0))),
    CONSTRAINT mite_counts_method_check CHECK ((method = ANY (ARRAY['alcohol_wash'::text, 'sugar_roll'::text, 'sticky_board'::text, 'visual'::text]))),
    CONSTRAINT mite_counts_mites_count_check CHECK ((mites_count >= 0)),
    CONSTRAINT mite_counts_sample_size_check CHECK (((sample_size IS NULL) OR (sample_size > 0)))
);


--
-- Name: ntfy_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ntfy_dispatches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_kind text NOT NULL,
    event_key text NOT NULL,
    title text,
    body text,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ntfy_dispatches_event_kind_check CHECK ((event_kind = ANY (ARRAY['mite_check_due'::text, 'feeder_empty'::text, 'treatment_off_date'::text, 'flow_started'::text])))
);


--
-- Name: offline_mutation_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offline_mutation_receipts (
    user_id uuid NOT NULL,
    mutation_id uuid NOT NULL,
    state text DEFAULT 'processing'::text NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_hash text,
    CONSTRAINT offline_mutation_receipts_state_check CHECK ((state = ANY (ARRAY['processing'::text, 'complete'::text])))
);


--
-- Name: oidc_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    display_name text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid
);


--
-- Name: photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_type public.media_owner_type NOT NULL,
    owner_id uuid NOT NULL,
    original_key text,
    thumbnail_key text,
    medium_key text,
    taken_date timestamp with time zone,
    caption text,
    tags jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_backend public.photo_storage_backend DEFAULT 'minio'::public.photo_storage_backend NOT NULL,
    original_ref text NOT NULL,
    original_external boolean DEFAULT false NOT NULL,
    comparison_angle text,
    CONSTRAINT photos_comparison_angle_ck CHECK (((comparison_angle IS NULL) OR ((char_length(btrim(comparison_angle)) >= 1) AND (char_length(btrim(comparison_angle)) <= 80)))),
    CONSTRAINT photos_original_backend_ck CHECK ((((storage_backend = 'minio'::public.photo_storage_backend) AND (original_key IS NOT NULL) AND (original_ref = original_key) AND (original_external = false)) OR ((storage_backend = 'immich'::public.photo_storage_backend) AND (original_ref <> ''::text) AND (original_key IS NULL))))
);


--
-- Name: product_batch_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_batch_expenses (
    batch_id uuid NOT NULL,
    expense_id uuid NOT NULL
);


--
-- Name: product_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    product_id uuid NOT NULL,
    harvest_lot_id uuid,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    honey_lbs double precision,
    water_liters double precision,
    yeast text,
    vessel text,
    propolis_harvest_id uuid,
    propolis_amount double precision,
    propolis_unit text,
    quantity_out integer NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    propolis_amount_grams double precision GENERATED ALWAYS AS (
CASE
    WHEN (propolis_amount IS NULL) THEN NULL::double precision
    WHEN (propolis_unit = 'ounces'::text) THEN (propolis_amount * (28.349523125)::double precision)
    ELSE propolis_amount
END) STORED,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    inventory_lot_id uuid,
    CONSTRAINT product_batches_creamed_lot_check CHECK (((kind <> 'creamed_honey'::text) OR (harvest_lot_id IS NOT NULL))),
    CONSTRAINT product_batches_honey_inputs_check CHECK ((((kind = ANY (ARRAY['creamed_honey'::text, 'hot_honey'::text, 'mead'::text])) AND (honey_lbs IS NOT NULL) AND (honey_lbs > (0)::double precision) AND (propolis_harvest_id IS NULL) AND (propolis_amount IS NULL)) OR ((kind = 'tincture'::text) AND (honey_lbs IS NULL) AND (propolis_harvest_id IS NOT NULL) AND (propolis_amount IS NOT NULL) AND (propolis_amount > (0)::double precision) AND (propolis_unit IS NOT NULL)))),
    CONSTRAINT product_batches_honey_lbs_check CHECK (((honey_lbs IS NULL) OR (honey_lbs >= (0)::double precision))),
    CONSTRAINT product_batches_kind_check CHECK ((kind = ANY (ARRAY['creamed_honey'::text, 'hot_honey'::text, 'mead'::text, 'tincture'::text]))),
    CONSTRAINT product_batches_propolis_amount_check CHECK (((propolis_amount IS NULL) OR (propolis_amount >= (0)::double precision))),
    CONSTRAINT product_batches_propolis_unit_check CHECK (((propolis_unit IS NULL) OR (propolis_unit = ANY (ARRAY['grams'::text, 'ounces'::text])))),
    CONSTRAINT product_batches_quantity_out_check CHECK ((quantity_out > 0)),
    CONSTRAINT product_batches_water_liters_check CHECK (((water_liters IS NULL) OR (water_liters >= (0)::double precision)))
);


--
-- Name: COLUMN product_batches.voided_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_batches.voided_at IS 'Set by POST /product-batches/{id}/void. A voided batch produces nothing, consumes no propolis, and its honey bulk_use movement carries a reversing entry.';


--
-- Name: propolis_harvests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.propolis_harvests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid,
    apiary_id uuid,
    date timestamp with time zone NOT NULL,
    amount double precision NOT NULL,
    unit text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    amount_grams double precision GENERATED ALWAYS AS (
CASE
    WHEN (unit = 'ounces'::text) THEN (amount * (28.349523125)::double precision)
    ELSE amount
END) STORED,
    CONSTRAINT propolis_harvests_amount_check CHECK ((amount > (0)::double precision)),
    CONSTRAINT propolis_harvests_source_check CHECK (((hive_id IS NOT NULL) OR (apiary_id IS NOT NULL))),
    CONSTRAINT propolis_harvests_unit_check CHECK ((unit = ANY (ARRAY['grams'::text, 'ounces'::text])))
);


--
-- Name: queen_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queen_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    queen_id uuid,
    event_date timestamp with time zone NOT NULL,
    event_type text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queen_events_event_type_check CHECK ((event_type = ANY (ARRAY['observed'::text, 'introduced'::text, 'superseded'::text, 'missing'::text, 'dead'::text, 'requeened'::text])))
);


--
-- Name: queens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid,
    origin public.queen_origin NOT NULL,
    origin_hive_id uuid,
    parent_queen_id uuid,
    introduced_date timestamp with time zone,
    status public.queen_status DEFAULT 'active'::public.queen_status NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mated_at_apiary_id uuid,
    drone_source_note text
);


--
-- Name: COLUMN queens.mated_at_apiary_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.queens.mated_at_apiary_id IS 'Mating yard: the apiary where this queen mated.';


--
-- Name: COLUMN queens.drone_source_note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.queens.drone_source_note IS 'Optional free-text note on drone source (which yards were flooding drones).';


--
-- Name: scale_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scale_readings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scale_id uuid NOT NULL,
    reading_date date NOT NULL,
    weight_lb numeric(9,3) NOT NULL,
    weight_min_lb numeric(9,3),
    weight_max_lb numeric(9,3),
    temperature_f numeric(6,2),
    humidity_pct numeric(5,2),
    sample_count integer DEFAULT 1 NOT NULL,
    source_file text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scale_readings_humidity_pct_check CHECK (((humidity_pct IS NULL) OR ((humidity_pct >= (0)::numeric) AND (humidity_pct <= (100)::numeric)))),
    CONSTRAINT scale_readings_sample_count_check CHECK ((sample_count > 0))
);


--
-- Name: schema_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_generation (
    generation text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE schema_generation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.schema_generation IS 'Exactly one row naming the schema generation this database belongs to. Checked by internal/db.CheckGeneration at every entry point; a database with no such table is generation "legacy".';


--
-- Name: transcript_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_file_id uuid NOT NULL,
    provider text NOT NULL,
    model text,
    prompt_revision text,
    produced_at timestamp with time zone DEFAULT now() NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: treatment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hive_id uuid NOT NULL,
    inspection_id uuid,
    date_applied timestamp with time zone NOT NULL,
    product text NOT NULL,
    method text,
    date_removed timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_media_file_id uuid,
    source_transcript_version_id uuid,
    withdrawal_days integer DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT treatment_events_withdrawal_days_check CHECK (((withdrawal_days IS NULL) OR (withdrawal_days >= 0)))
);


--
-- Name: treatment_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatment_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    name_key text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    withdrawal_days integer NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT treatment_products_withdrawal_days_check CHECK ((withdrawal_days >= 0))
);


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    password_hash text,
    display_name text,
    ai_provider_config jsonb,
    theme text DEFAULT 'system'::text,
    default_apiary_id uuid,
    date_format text DEFAULT 'MM/DD/YYYY'::text,
    weight_unit text DEFAULT 'oz'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mite_threshold_per_100 double precision,
    mite_threshold_per_day double precision,
    mite_check_interval_days integer,
    moisture_threshold_pct double precision,
    units text,
    temperature_unit text,
    labor_tracking_enabled boolean DEFAULT false NOT NULL,
    ntfy_server_url text,
    ntfy_topic text,
    ntfy_enabled boolean DEFAULT false NOT NULL,
    ntfy_event_kinds text[] DEFAULT '{}'::text[] NOT NULL,
    ntfy_access_token text,
    CONSTRAINT user_settings_mite_check_interval_days_check CHECK (((mite_check_interval_days IS NULL) OR (mite_check_interval_days > 0))),
    CONSTRAINT user_settings_mite_threshold_per_100_check CHECK (((mite_threshold_per_100 IS NULL) OR (mite_threshold_per_100 > (0)::double precision))),
    CONSTRAINT user_settings_mite_threshold_per_day_check CHECK (((mite_threshold_per_day IS NULL) OR (mite_threshold_per_day > (0)::double precision))),
    CONSTRAINT user_settings_moisture_threshold_pct_check CHECK (((moisture_threshold_pct IS NULL) OR ((moisture_threshold_pct > (0)::double precision) AND (moisture_threshold_pct <= (100)::double precision)))),
    CONSTRAINT user_settings_temperature_unit_check CHECK (((temperature_unit IS NULL) OR (temperature_unit = ANY (ARRAY['c'::text, 'f'::text])))),
    CONSTRAINT user_settings_units_check CHECK (((units IS NULL) OR (units = ANY (ARRAY['metric'::text, 'us'::text]))))
);


--
-- Name: COLUMN user_settings.units; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_settings.units IS 'Display system: metric or us. NULL means unset; the client defaults from locale.';


--
-- Name: COLUMN user_settings.temperature_unit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_settings.temperature_unit IS 'Optional temperature override (c or f). NULL follows units.';


--
-- Name: COLUMN user_settings.labor_tracking_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_settings.labor_tracking_enabled IS 'Yard-visit start/stop. Off by default; do not guilt a hobbyist.';


--
-- Name: COLUMN user_settings.ntfy_access_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_settings.ntfy_access_token IS 'Optional bearer token for reserved or protected ntfy topics.';


--
-- Name: wholesale_price_list_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wholesale_price_list_items (
    price_list_id uuid NOT NULL,
    jar_size_id uuid NOT NULL,
    unit_price_cents bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT wholesale_price_list_items_unit_price_cents_check CHECK ((unit_price_cents >= 0))
);


--
-- Name: wholesale_price_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wholesale_price_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    minimum_order_amount_cents bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT wholesale_price_lists_minimum_cents_check CHECK ((minimum_order_amount_cents >= 0))
);


--
-- Name: yard_labor_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.yard_labor_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid,
    started_at timestamp with time zone NOT NULL,
    stopped_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT yard_labor_sessions_stop_check CHECK (((stopped_at IS NULL) OR (stopped_at >= started_at)))
);


--
-- Name: yard_scales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.yard_scales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apiary_id uuid NOT NULL,
    hive_id uuid,
    name text NOT NULL,
    vendor text DEFAULT 'other'::text NOT NULL,
    device_id text,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT yard_scales_vendor_check CHECK ((vendor = ANY (ARRAY['broodminder'::text, 'hivetracks'::text, 'other'::text])))
);


--
-- Name: ai_recommendations ai_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recommendations
    ADD CONSTRAINT ai_recommendations_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: apiaries apiaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apiaries
    ADD CONSTRAINT apiaries_pkey PRIMARY KEY (id);


--
-- Name: apiary_memberships apiary_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apiary_memberships
    ADD CONSTRAINT apiary_memberships_pkey PRIMARY KEY (user_id, apiary_id);


--
-- Name: apiary_weather_cache apiary_weather_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apiary_weather_cache
    ADD CONSTRAINT apiary_weather_cache_pkey PRIMARY KEY (apiary_id);


--
-- Name: app_users app_users_auth_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_auth_subject_key UNIQUE (auth_subject);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: bloom_observations bloom_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bloom_observations
    ADD CONSTRAINT bloom_observations_pkey PRIMARY KEY (id);


--
-- Name: bottling_runs bottling_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bottling_runs
    ADD CONSTRAINT bottling_runs_pkey PRIMARY KEY (id);


--
-- Name: catch_boxes catch_boxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catch_boxes
    ADD CONSTRAINT catch_boxes_pkey PRIMARY KEY (id);


--
-- Name: colony_intakes colony_intakes_expense_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_expense_id_key UNIQUE (expense_id);


--
-- Name: colony_intakes colony_intakes_hive_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_hive_id_key UNIQUE (hive_id);


--
-- Name: colony_intakes colony_intakes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_pkey PRIMARY KEY (id);


--
-- Name: consignment_settlements consignment_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_settlements
    ADD CONSTRAINT consignment_settlements_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: customers customers_referral_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_referral_code_key UNIQUE (referral_code);


--
-- Name: deadout_autopsies deadout_autopsies_hive_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadout_autopsies
    ADD CONSTRAINT deadout_autopsies_hive_id_key UNIQUE (hive_id);


--
-- Name: deadout_autopsies deadout_autopsies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadout_autopsies
    ADD CONSTRAINT deadout_autopsies_pkey PRIMARY KEY (id);


--
-- Name: equipment_types equipment_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_name_key UNIQUE (name);


--
-- Name: equipment_types equipment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: external_sync external_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_sync
    ADD CONSTRAINT external_sync_pkey PRIMARY KEY (id);


--
-- Name: feeding_status_backfills feeding_status_backfills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeding_status_backfills
    ADD CONSTRAINT feeding_status_backfills_pkey PRIMARY KEY (id);


--
-- Name: feedings feedings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_pkey PRIMARY KEY (id);


--
-- Name: field_incidents field_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_incidents
    ADD CONSTRAINT field_incidents_pkey PRIMARY KEY (id);


--
-- Name: gnucash_sync_settings gnucash_sync_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gnucash_sync_settings
    ADD CONSTRAINT gnucash_sync_settings_pkey PRIMARY KEY (id);


--
-- Name: harvest_lot_harvests harvest_lot_harvests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lot_harvests
    ADD CONSTRAINT harvest_lot_harvests_pkey PRIMARY KEY (lot_id, harvest_id);


--
-- Name: harvest_lot_photos harvest_lot_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lot_photos
    ADD CONSTRAINT harvest_lot_photos_pkey PRIMARY KEY (lot_id, photo_id);


--
-- Name: harvest_lots harvest_lots_lot_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_lot_code_key UNIQUE (lot_code);


--
-- Name: harvest_lots harvest_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_pkey PRIMARY KEY (id);


--
-- Name: harvest_lots harvest_lots_public_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_public_slug_key UNIQUE (public_slug);


--
-- Name: harvest_session_true_ups harvest_session_true_ups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_session_true_ups
    ADD CONSTRAINT harvest_session_true_ups_pkey PRIMARY KEY (id);


--
-- Name: harvest_sessions harvest_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_sessions
    ADD CONSTRAINT harvest_sessions_pkey PRIMARY KEY (id);


--
-- Name: hive_location_history hive_location_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hive_location_history
    ADD CONSTRAINT hive_location_history_pkey PRIMARY KEY (id);


--
-- Name: hive_splits hive_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hive_splits
    ADD CONSTRAINT hive_splits_pkey PRIMARY KEY (id);


--
-- Name: hives hives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hives
    ADD CONSTRAINT hives_pkey PRIMARY KEY (id);


--
-- Name: honey_harvests honey_harvests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_harvests
    ADD CONSTRAINT honey_harvests_pkey PRIMARY KEY (id);


--
-- Name: honey_varietals honey_varietals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_varietals
    ADD CONSTRAINT honey_varietals_pkey PRIMARY KEY (id);


--
-- Name: immich_timeline_candidates immich_timeline_candidates_apiary_id_immich_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_candidates
    ADD CONSTRAINT immich_timeline_candidates_apiary_id_immich_asset_id_key UNIQUE (apiary_id, immich_asset_id);


--
-- Name: immich_timeline_candidates immich_timeline_candidates_photo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_candidates
    ADD CONSTRAINT immich_timeline_candidates_photo_id_key UNIQUE (photo_id);


--
-- Name: immich_timeline_candidates immich_timeline_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_candidates
    ADD CONSTRAINT immich_timeline_candidates_pkey PRIMARY KEY (id);


--
-- Name: immich_timeline_scans immich_timeline_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_scans
    ADD CONSTRAINT immich_timeline_scans_pkey PRIMARY KEY (id);


--
-- Name: inspections inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT inspections_pkey PRIMARY KEY (id);


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_pkey PRIMARY KEY (id);


--
-- Name: inventory_bom_lines inventory_bom_lines_bom_id_role_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_bom_lines
    ADD CONSTRAINT inventory_bom_lines_bom_id_role_item_id_key UNIQUE (bom_id, role, item_id);


--
-- Name: inventory_bom_lines inventory_bom_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_bom_lines
    ADD CONSTRAINT inventory_bom_lines_pkey PRIMARY KEY (id);


--
-- Name: inventory_boms inventory_boms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_boms
    ADD CONSTRAINT inventory_boms_pkey PRIMARY KEY (id);


--
-- Name: inventory_conditions inventory_conditions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_conditions
    ADD CONSTRAINT inventory_conditions_pkey PRIMARY KEY (condition);


--
-- Name: inventory_item_kinds inventory_item_kinds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_item_kinds
    ADD CONSTRAINT inventory_item_kinds_pkey PRIMARY KEY (kind);


--
-- Name: inventory_items inventory_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);


--
-- Name: inventory_items inventory_items_source_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_source_type_source_id_key UNIQUE (source_type, source_id);


--
-- Name: inventory_location_kinds inventory_location_kinds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_location_kinds
    ADD CONSTRAINT inventory_location_kinds_pkey PRIMARY KEY (kind);


--
-- Name: inventory_locations inventory_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_pkey PRIMARY KEY (id);


--
-- Name: inventory_locations inventory_locations_source_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_source_type_source_id_key UNIQUE (source_type, source_id);


--
-- Name: inventory_lots inventory_lots_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_lots
    ADD CONSTRAINT inventory_lots_id_item_id_key UNIQUE (id, item_id);


--
-- Name: inventory_lots inventory_lots_item_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_lots
    ADD CONSTRAINT inventory_lots_item_id_code_key UNIQUE (item_id, code);


--
-- Name: inventory_lots inventory_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_lots
    ADD CONSTRAINT inventory_lots_pkey PRIMARY KEY (id);


--
-- Name: inventory_movements inventory_movements_operation_id_line_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_operation_id_line_no_key UNIQUE (operation_id, line_no);


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);


--
-- Name: inventory_operation_kinds inventory_operation_kinds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operation_kinds
    ADD CONSTRAINT inventory_operation_kinds_pkey PRIMARY KEY (kind);


--
-- Name: inventory_operation_reasons inventory_operation_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operation_reasons
    ADD CONSTRAINT inventory_operation_reasons_pkey PRIMARY KEY (reason);


--
-- Name: inventory_operations inventory_operations_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operations
    ADD CONSTRAINT inventory_operations_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: inventory_operations inventory_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operations
    ADD CONSTRAINT inventory_operations_pkey PRIMARY KEY (id);


--
-- Name: jar_serials jar_serials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_serials
    ADD CONSTRAINT jar_serials_pkey PRIMARY KEY (id);


--
-- Name: jar_serials jar_serials_serial_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_serials
    ADD CONSTRAINT jar_serials_serial_number_key UNIQUE (serial_number);


--
-- Name: jar_sizes jar_sizes_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_sizes
    ADD CONSTRAINT jar_sizes_label_key UNIQUE (label);


--
-- Name: jar_sizes jar_sizes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_sizes
    ADD CONSTRAINT jar_sizes_pkey PRIMARY KEY (id);


--
-- Name: media_files media_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_pkey PRIMARY KEY (id);


--
-- Name: mite_counts mite_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_pkey PRIMARY KEY (id);


--
-- Name: ntfy_dispatches ntfy_dispatches_event_kind_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ntfy_dispatches
    ADD CONSTRAINT ntfy_dispatches_event_kind_event_key_key UNIQUE (event_kind, event_key);


--
-- Name: ntfy_dispatches ntfy_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ntfy_dispatches
    ADD CONSTRAINT ntfy_dispatches_pkey PRIMARY KEY (id);


--
-- Name: offline_mutation_receipts offline_mutation_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_mutation_receipts
    ADD CONSTRAINT offline_mutation_receipts_pkey PRIMARY KEY (user_id, mutation_id);


--
-- Name: oidc_identities oidc_identities_issuer_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_identities
    ADD CONSTRAINT oidc_identities_issuer_subject_key UNIQUE (issuer, subject);


--
-- Name: oidc_identities oidc_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_identities
    ADD CONSTRAINT oidc_identities_pkey PRIMARY KEY (id);


--
-- Name: photos photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_pkey PRIMARY KEY (id);


--
-- Name: product_batch_expenses product_batch_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batch_expenses
    ADD CONSTRAINT product_batch_expenses_pkey PRIMARY KEY (batch_id, expense_id);


--
-- Name: product_batches product_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_pkey PRIMARY KEY (id);


--
-- Name: product_catalog product_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_pkey PRIMARY KEY (id);


--
-- Name: propolis_harvests propolis_harvests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propolis_harvests
    ADD CONSTRAINT propolis_harvests_pkey PRIMARY KEY (id);


--
-- Name: queen_events queen_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queen_events
    ADD CONSTRAINT queen_events_pkey PRIMARY KEY (id);


--
-- Name: queens queens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queens
    ADD CONSTRAINT queens_pkey PRIMARY KEY (id);


--
-- Name: sale_items sale_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_pkey PRIMARY KEY (id);


--
-- Name: sales sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);


--
-- Name: scale_readings scale_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_readings
    ADD CONSTRAINT scale_readings_pkey PRIMARY KEY (id);


--
-- Name: scale_readings scale_readings_scale_id_reading_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_readings
    ADD CONSTRAINT scale_readings_scale_id_reading_date_key UNIQUE (scale_id, reading_date);


--
-- Name: schema_generation schema_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_generation
    ADD CONSTRAINT schema_generation_pkey PRIMARY KEY (generation);


--
-- Name: transcript_versions transcript_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_versions
    ADD CONSTRAINT transcript_versions_pkey PRIMARY KEY (id);


--
-- Name: treatment_events treatment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_pkey PRIMARY KEY (id);


--
-- Name: treatment_products treatment_products_name_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_products
    ADD CONSTRAINT treatment_products_name_key_key UNIQUE (name_key);


--
-- Name: treatment_products treatment_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_products
    ADD CONSTRAINT treatment_products_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (id);


--
-- Name: wholesale_price_list_items wholesale_price_list_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_list_items
    ADD CONSTRAINT wholesale_price_list_items_pkey PRIMARY KEY (price_list_id, jar_size_id);


--
-- Name: wholesale_price_lists wholesale_price_lists_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_lists
    ADD CONSTRAINT wholesale_price_lists_name_key UNIQUE (name);


--
-- Name: wholesale_price_lists wholesale_price_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_lists
    ADD CONSTRAINT wholesale_price_lists_pkey PRIMARY KEY (id);


--
-- Name: yard_labor_sessions yard_labor_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_labor_sessions
    ADD CONSTRAINT yard_labor_sessions_pkey PRIMARY KEY (id);


--
-- Name: yard_scales yard_scales_apiary_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_scales
    ADD CONSTRAINT yard_scales_apiary_id_name_key UNIQUE (apiary_id, name);


--
-- Name: yard_scales yard_scales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_scales
    ADD CONSTRAINT yard_scales_pkey PRIMARY KEY (id);


--
-- Name: ai_recommendations_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_recommendations_active_unique ON public.ai_recommendations USING btree (type, COALESCE(hive_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (dismissed = false);


--
-- Name: ai_recommendations_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_recommendations_hive_id_idx ON public.ai_recommendations USING btree (hive_id);


--
-- Name: ai_recommendations_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_recommendations_pending_idx ON public.ai_recommendations USING btree (dismissed, snoozed_until);


--
-- Name: api_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_user_idx ON public.api_tokens USING btree (user_id);


--
-- Name: apiary_memberships_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apiary_memberships_apiary_idx ON public.apiary_memberships USING btree (apiary_id);


--
-- Name: app_users_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_users_email_lower_idx ON public.app_users USING btree (lower(email)) WHERE (email IS NOT NULL);


--
-- Name: app_users_username_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_users_username_lower_idx ON public.app_users USING btree (lower(username)) WHERE (username IS NOT NULL);


--
-- Name: bloom_observations_apiary_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bloom_observations_apiary_id_idx ON public.bloom_observations USING btree (apiary_id);


--
-- Name: bloom_observations_band_species_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bloom_observations_band_species_idx ON public.bloom_observations USING btree (elevation_band, species, year DESC);


--
-- Name: bottling_runs_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bottling_runs_created_by_idx ON public.bottling_runs USING btree (created_by);


--
-- Name: bottling_runs_lot_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bottling_runs_lot_date_idx ON public.bottling_runs USING btree (lot_id, bottled_date DESC);


--
-- Name: catch_boxes_apiary_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catch_boxes_apiary_live_idx ON public.catch_boxes USING btree (apiary_id, date_set DESC) WHERE (deleted_at IS NULL);


--
-- Name: colony_intakes_apiary_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX colony_intakes_apiary_date_idx ON public.colony_intakes USING btree (apiary_id, intake_date DESC);


--
-- Name: colony_intakes_cohort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX colony_intakes_cohort_idx ON public.colony_intakes USING btree (cohort_year, queen_id);


--
-- Name: consignment_settlements_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consignment_settlements_created_by_idx ON public.consignment_settlements USING btree (created_by);


--
-- Name: consignment_settlements_location_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consignment_settlements_location_idx ON public.consignment_settlements USING btree (location_id, period_end DESC);


--
-- Name: consignment_settlements_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consignment_settlements_period_idx ON public.consignment_settlements USING btree (location_id, period_start, period_end) WHERE (voided_at IS NULL);


--
-- Name: consignment_settlements_sale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consignment_settlements_sale_idx ON public.consignment_settlements USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: customers_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_created_by_idx ON public.customers USING btree (created_by);


--
-- Name: customers_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customers_email_lower_idx ON public.customers USING btree (lower(email)) WHERE (email IS NOT NULL);


--
-- Name: customers_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_name_idx ON public.customers USING btree (lower(name));


--
-- Name: deadout_autopsies_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deadout_autopsies_date_idx ON public.deadout_autopsies USING btree (autopsy_date DESC);


--
-- Name: equipment_types_variant_of_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX equipment_types_variant_of_idx ON public.equipment_types USING btree (variant_of_type_id);


--
-- Name: expenses_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_apiary_idx ON public.expenses USING btree (apiary_id);


--
-- Name: expenses_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_created_by_idx ON public.expenses USING btree (created_by);


--
-- Name: expenses_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_date_idx ON public.expenses USING btree (expense_date DESC);


--
-- Name: expenses_live_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_live_date_idx ON public.expenses USING btree (expense_date DESC) WHERE (deleted_at IS NULL);


--
-- Name: expenses_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_lot_idx ON public.expenses USING btree (harvest_lot_id);


--
-- Name: external_sync_conflict_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_sync_conflict_idx ON public.external_sync USING btree (system, conflict_state) WHERE ((conflict_state IS NOT NULL) AND (conflict_state <> 'none'::text));


--
-- Name: external_sync_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_sync_entity_idx ON public.external_sync USING btree (system, entity_type, entity_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: external_sync_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_sync_external_idx ON public.external_sync USING btree (system, entity_type, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: external_sync_external_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_sync_external_lookup_idx ON public.external_sync USING btree (system, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: external_sync_location_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_sync_location_idx ON public.external_sync USING btree (location_id) WHERE (location_id IS NOT NULL);


--
-- Name: external_sync_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_sync_state_idx ON public.external_sync USING btree (system, sync_state, last_synced_at);


--
-- Name: feeding_status_backfills_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feeding_status_backfills_batch_idx ON public.feeding_status_backfills USING btree (batch) WHERE (reverted_at IS NULL);


--
-- Name: feeding_status_backfills_feeding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feeding_status_backfills_feeding_idx ON public.feeding_status_backfills USING btree (feeding_id);


--
-- Name: feedings_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedings_hive_id_idx ON public.feedings USING btree (hive_id);


--
-- Name: feedings_hive_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedings_hive_status_idx ON public.feedings USING btree (hive_id, status);


--
-- Name: feedings_refill_of_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feedings_refill_of_idx ON public.feedings USING btree (refill_of_id) WHERE (refill_of_id IS NOT NULL);


--
-- Name: feedings_sale_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedings_sale_id_idx ON public.feedings USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: feedings_source_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedings_source_media_idx ON public.feedings USING btree (source_media_file_id) WHERE (source_media_file_id IS NOT NULL);


--
-- Name: field_incidents_apiary_date_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX field_incidents_apiary_date_live_idx ON public.field_incidents USING btree (apiary_id, incident_date DESC) WHERE (deleted_at IS NULL);


--
-- Name: field_incidents_hive_date_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX field_incidents_hive_date_live_idx ON public.field_incidents USING btree (hive_id, incident_date DESC) WHERE (deleted_at IS NULL);


--
-- Name: harvest_lot_harvests_harvest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_lot_harvests_harvest_idx ON public.harvest_lot_harvests USING btree (harvest_id);


--
-- Name: harvest_lots_claim_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_lots_claim_apiary_idx ON public.harvest_lots USING btree (claim_apiary_id) WHERE (claim_apiary_id IS NOT NULL);


--
-- Name: harvest_lots_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_lots_created_by_idx ON public.harvest_lots USING btree (created_by);


--
-- Name: harvest_lots_varietal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_lots_varietal_idx ON public.harvest_lots USING btree (varietal_id) WHERE (varietal_id IS NOT NULL);


--
-- Name: harvest_session_true_ups_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_session_true_ups_session_idx ON public.harvest_session_true_ups USING btree (session_id, created_at DESC);


--
-- Name: harvest_sessions_apiary_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_sessions_apiary_id_idx ON public.harvest_sessions USING btree (apiary_id);


--
-- Name: harvest_sessions_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harvest_sessions_created_by_idx ON public.harvest_sessions USING btree (created_by);


--
-- Name: hive_location_history_apiary_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hive_location_history_apiary_id_idx ON public.hive_location_history USING btree (apiary_id);


--
-- Name: hive_location_history_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hive_location_history_hive_id_idx ON public.hive_location_history USING btree (hive_id);


--
-- Name: hive_splits_child_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hive_splits_child_hive_id_idx ON public.hive_splits USING btree (child_hive_id);


--
-- Name: hive_splits_parent_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hive_splits_parent_hive_id_idx ON public.hive_splits USING btree (parent_hive_id);


--
-- Name: hives_apiary_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hives_apiary_id_idx ON public.hives USING btree (apiary_id);


--
-- Name: hives_gps_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hives_gps_idx ON public.hives USING btree (latitude, longitude) WHERE ((latitude IS NOT NULL) AND (longitude IS NOT NULL));


--
-- Name: hives_sale_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hives_sale_id_idx ON public.hives USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: honey_harvests_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX honey_harvests_created_by_idx ON public.honey_harvests USING btree (created_by);


--
-- Name: honey_harvests_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX honey_harvests_hive_id_idx ON public.honey_harvests USING btree (hive_id);


--
-- Name: honey_harvests_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX honey_harvests_live_idx ON public.honey_harvests USING btree (session_id) WHERE (deleted_at IS NULL);


--
-- Name: honey_harvests_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX honey_harvests_session_id_idx ON public.honey_harvests USING btree (session_id);


--
-- Name: honey_varietals_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX honey_varietals_name_key ON public.honey_varietals USING btree (lower(name));


--
-- Name: immich_timeline_candidates_photo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX immich_timeline_candidates_photo_idx ON public.immich_timeline_candidates USING btree (photo_id) WHERE (photo_id IS NOT NULL);


--
-- Name: immich_timeline_candidates_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX immich_timeline_candidates_review_idx ON public.immich_timeline_candidates USING btree (apiary_id, review_state, taken_date);


--
-- Name: immich_timeline_scans_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX immich_timeline_scans_history_idx ON public.immich_timeline_scans USING btree (apiary_id, requested_at DESC);


--
-- Name: immich_timeline_scans_one_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX immich_timeline_scans_one_active_idx ON public.immich_timeline_scans USING btree (apiary_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: inspections_hive_id_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inspections_hive_id_date_idx ON public.inspections USING btree (hive_id, date DESC);


--
-- Name: inspections_source_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inspections_source_media_idx ON public.inspections USING btree (source_media_file_id) WHERE (source_media_file_id IS NOT NULL);


--
-- Name: inventory_balance_checkpoints_tuple_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inventory_balance_checkpoints_tuple_idx ON public.inventory_balance_checkpoints USING btree (item_id, location_id, lot_id, condition, container_hive_id) NULLS NOT DISTINCT;


--
-- Name: inventory_locations_single_deployed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inventory_locations_single_deployed_idx ON public.inventory_locations USING btree (kind) WHERE (kind = 'deployed'::text);


--
-- Name: inventory_locations_single_home_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inventory_locations_single_home_idx ON public.inventory_locations USING btree (is_home) WHERE is_home;


--
-- Name: inventory_movements_tuple_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_movements_tuple_idx ON public.inventory_movements USING btree (item_id, location_id, lot_id, condition, container_hive_id);


--
-- Name: inventory_operations_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_operations_occurred_idx ON public.inventory_operations USING btree (occurred_at DESC, id);


--
-- Name: inventory_operations_single_reversal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inventory_operations_single_reversal ON public.inventory_operations USING btree (reverses_operation_id) WHERE (reverses_operation_id IS NOT NULL);


--
-- Name: inventory_operations_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inventory_operations_source_idx ON public.inventory_operations USING btree (source_type, source_id);


--
-- Name: jar_serials_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jar_serials_run_idx ON public.jar_serials USING btree (bottling_run_id);


--
-- Name: jar_serials_sale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jar_serials_sale_idx ON public.jar_serials USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: jar_serials_serial_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jar_serials_serial_lower_idx ON public.jar_serials USING btree (lower(serial_number));


--
-- Name: jar_sizes_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jar_sizes_created_by_idx ON public.jar_sizes USING btree (created_by);


--
-- Name: jar_sizes_packaging_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jar_sizes_packaging_type_idx ON public.jar_sizes USING btree (packaging_type_id) WHERE (packaging_type_id IS NOT NULL);


--
-- Name: media_files_current_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_files_current_version_idx ON public.media_files USING btree (current_transcript_version_id) WHERE (current_transcript_version_id IS NOT NULL);


--
-- Name: media_files_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_files_owner_idx ON public.media_files USING btree (owner_type, owner_id);


--
-- Name: mite_counts_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mite_counts_created_by_idx ON public.mite_counts USING btree (created_by);


--
-- Name: mite_counts_hive_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mite_counts_hive_date_idx ON public.mite_counts USING btree (hive_id, date DESC);


--
-- Name: mite_counts_inspection_method_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mite_counts_inspection_method_uidx ON public.mite_counts USING btree (inspection_id, method) WHERE ((inspection_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: mite_counts_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mite_counts_live_idx ON public.mite_counts USING btree (hive_id, date DESC) WHERE (deleted_at IS NULL);


--
-- Name: mite_counts_source_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mite_counts_source_media_idx ON public.mite_counts USING btree (source_media_file_id) WHERE (source_media_file_id IS NOT NULL);


--
-- Name: mite_counts_standalone_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mite_counts_standalone_uidx ON public.mite_counts USING btree (hive_id, date, method) WHERE ((inspection_id IS NULL) AND (deleted_at IS NULL));


--
-- Name: ntfy_dispatches_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ntfy_dispatches_kind_idx ON public.ntfy_dispatches USING btree (event_kind, dispatched_at DESC);


--
-- Name: offline_mutation_receipts_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offline_mutation_receipts_created_idx ON public.offline_mutation_receipts USING btree (created_at);


--
-- Name: oidc_identities_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oidc_identities_user_idx ON public.oidc_identities USING btree (user_id);


--
-- Name: photos_hive_comparison_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_hive_comparison_idx ON public.photos USING btree (owner_id, comparison_angle, taken_date) WHERE ((owner_type = 'hive'::public.media_owner_type) AND (comparison_angle IS NOT NULL) AND (taken_date IS NOT NULL));


--
-- Name: photos_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_owner_idx ON public.photos USING btree (owner_type, owner_id);


--
-- Name: product_batch_expenses_expense_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batch_expenses_expense_idx ON public.product_batch_expenses USING btree (expense_id);


--
-- Name: product_batches_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batches_created_by_idx ON public.product_batches USING btree (created_by);


--
-- Name: product_batches_kind_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batches_kind_started_idx ON public.product_batches USING btree (kind, started_at DESC);


--
-- Name: product_batches_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batches_live_idx ON public.product_batches USING btree (product_id) WHERE (voided_at IS NULL);


--
-- Name: product_batches_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batches_lot_idx ON public.product_batches USING btree (harvest_lot_id) WHERE (harvest_lot_id IS NOT NULL);


--
-- Name: product_batches_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batches_product_idx ON public.product_batches USING btree (product_id);


--
-- Name: product_batches_propolis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_batches_propolis_idx ON public.product_batches USING btree (propolis_harvest_id) WHERE (propolis_harvest_id IS NOT NULL);


--
-- Name: product_catalog_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_catalog_created_by_idx ON public.product_catalog USING btree (created_by);


--
-- Name: product_catalog_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_catalog_kind_idx ON public.product_catalog USING btree (kind);


--
-- Name: product_catalog_name_kind_size_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_catalog_name_kind_size_idx ON public.product_catalog USING btree (lower(name), kind, COALESCE(size_label, ''::text));


--
-- Name: propolis_harvests_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propolis_harvests_apiary_idx ON public.propolis_harvests USING btree (apiary_id) WHERE (apiary_id IS NOT NULL);


--
-- Name: propolis_harvests_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propolis_harvests_created_by_idx ON public.propolis_harvests USING btree (created_by);


--
-- Name: propolis_harvests_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propolis_harvests_date_idx ON public.propolis_harvests USING btree (date DESC);


--
-- Name: propolis_harvests_hive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propolis_harvests_hive_idx ON public.propolis_harvests USING btree (hive_id) WHERE (hive_id IS NOT NULL);


--
-- Name: propolis_harvests_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propolis_harvests_live_idx ON public.propolis_harvests USING btree (date DESC) WHERE (deleted_at IS NULL);


--
-- Name: queen_events_hive_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queen_events_hive_date_idx ON public.queen_events USING btree (hive_id, event_date DESC);


--
-- Name: queens_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queens_hive_id_idx ON public.queens USING btree (hive_id);


--
-- Name: queens_mated_at_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queens_mated_at_apiary_idx ON public.queens USING btree (mated_at_apiary_id) WHERE (mated_at_apiary_id IS NOT NULL);


--
-- Name: queens_parent_queen_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queens_parent_queen_id_idx ON public.queens USING btree (parent_queen_id);


--
-- Name: sale_items_bottling_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_bottling_run_idx ON public.sale_items USING btree (bottling_run_id) WHERE (bottling_run_id IS NOT NULL);


--
-- Name: sale_items_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_created_by_idx ON public.sale_items USING btree (created_by);


--
-- Name: sale_items_equipment_stock_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_equipment_stock_id_idx ON public.sale_items USING btree (equipment_stock_id) WHERE (equipment_stock_id IS NOT NULL);


--
-- Name: sale_items_hive_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_hive_id_idx ON public.sale_items USING btree (hive_id) WHERE (hive_id IS NOT NULL);


--
-- Name: sale_items_inventory_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_inventory_item_idx ON public.sale_items USING btree (item_id) WHERE (item_id IS NOT NULL);


--
-- Name: sale_items_inventory_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_inventory_lot_idx ON public.sale_items USING btree (inventory_lot_id) WHERE (inventory_lot_id IS NOT NULL);


--
-- Name: sale_items_jar_size_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_jar_size_id_idx ON public.sale_items USING btree (jar_size_id);


--
-- Name: sale_items_product_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_product_id_idx ON public.sale_items USING btree (product_id) WHERE (product_id IS NOT NULL);


--
-- Name: sale_items_sale_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_items_sale_id_idx ON public.sale_items USING btree (sale_id);


--
-- Name: sales_channel_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_channel_date_idx ON public.sales USING btree (channel, date DESC);


--
-- Name: sales_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_created_by_idx ON public.sales USING btree (created_by);


--
-- Name: sales_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_customer_idx ON public.sales USING btree (customer_id);


--
-- Name: sales_harvest_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_harvest_lot_idx ON public.sales USING btree (harvest_lot_id);


--
-- Name: sales_order_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sales_order_number_idx ON public.sales USING btree (order_number) WHERE (order_number IS NOT NULL);


--
-- Name: sales_stock_location_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_stock_location_idx ON public.sales USING btree (stock_location_id) WHERE (stock_location_id IS NOT NULL);


--
-- Name: scale_readings_scale_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scale_readings_scale_date_idx ON public.scale_readings USING btree (scale_id, reading_date DESC);


--
-- Name: transcript_versions_media_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_versions_media_file_idx ON public.transcript_versions USING btree (media_file_id, produced_at DESC);


--
-- Name: treatment_events_hive_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatment_events_hive_date_idx ON public.treatment_events USING btree (hive_id, date_applied DESC);


--
-- Name: treatment_events_inspection_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatment_events_inspection_id_idx ON public.treatment_events USING btree (inspection_id) WHERE (inspection_id IS NOT NULL);


--
-- Name: treatment_events_live_hive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatment_events_live_hive_idx ON public.treatment_events USING btree (hive_id, date_applied DESC) WHERE (deleted_at IS NULL);


--
-- Name: treatment_events_source_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatment_events_source_media_idx ON public.treatment_events USING btree (source_media_file_id) WHERE (source_media_file_id IS NOT NULL);


--
-- Name: user_settings_singleton; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_settings_singleton ON public.user_settings USING btree ((true));


--
-- Name: wholesale_price_list_items_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wholesale_price_list_items_created_by_idx ON public.wholesale_price_list_items USING btree (created_by);


--
-- Name: wholesale_price_lists_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wholesale_price_lists_created_by_idx ON public.wholesale_price_lists USING btree (created_by);


--
-- Name: yard_labor_sessions_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX yard_labor_sessions_apiary_idx ON public.yard_labor_sessions USING btree (apiary_id) WHERE ((apiary_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: yard_labor_sessions_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX yard_labor_sessions_created_by_idx ON public.yard_labor_sessions USING btree (created_by) WHERE (created_by IS NOT NULL);


--
-- Name: yard_labor_sessions_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX yard_labor_sessions_live_idx ON public.yard_labor_sessions USING btree (started_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: yard_labor_sessions_open_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX yard_labor_sessions_open_user_uidx ON public.yard_labor_sessions USING btree (created_by) WHERE ((stopped_at IS NULL) AND (deleted_at IS NULL) AND (created_by IS NOT NULL));


--
-- Name: yard_scales_apiary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX yard_scales_apiary_idx ON public.yard_scales USING btree (apiary_id, name);


--
-- Name: inventory_balances _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.inventory_balances AS
 WITH checkpoint_delta AS (
         SELECT c.item_id,
            c.location_id,
            c.lot_id,
            c.condition,
            c.container_hive_id,
            (c.on_hand + COALESCE(sum(m.quantity) FILTER (WHERE ((o.created_at > anchor.created_at) OR ((o.created_at = anchor.created_at) AND (o.id > anchor.id)))), (0)::numeric)) AS on_hand
           FROM (((public.inventory_balance_checkpoints c
             JOIN public.inventory_operations anchor ON ((anchor.id = c.as_of_operation_id)))
             LEFT JOIN public.inventory_movements m ON (((m.item_id = c.item_id) AND (m.location_id = c.location_id) AND (NOT (m.lot_id IS DISTINCT FROM c.lot_id)) AND (NOT (m.condition IS DISTINCT FROM c.condition)) AND (NOT (m.container_hive_id IS DISTINCT FROM c.container_hive_id)))))
             LEFT JOIN public.inventory_operations o ON ((o.id = m.operation_id)))
          GROUP BY c.id, anchor.created_at, anchor.id
        ), raw_without_checkpoint AS (
         SELECT m.item_id,
            m.location_id,
            m.lot_id,
            m.condition,
            m.container_hive_id,
            sum(m.quantity) AS on_hand
           FROM public.inventory_movements m
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM public.inventory_balance_checkpoints c
                  WHERE ((c.item_id = m.item_id) AND (c.location_id = m.location_id) AND (NOT (c.lot_id IS DISTINCT FROM m.lot_id)) AND (NOT (c.condition IS DISTINCT FROM m.condition)) AND (NOT (c.container_hive_id IS DISTINCT FROM m.container_hive_id))))))
          GROUP BY m.item_id, m.location_id, m.lot_id, m.condition, m.container_hive_id
        )
 SELECT checkpoint_delta.item_id,
    checkpoint_delta.location_id,
    checkpoint_delta.lot_id,
    checkpoint_delta.condition,
    checkpoint_delta.container_hive_id,
    checkpoint_delta.on_hand
   FROM checkpoint_delta
UNION ALL
 SELECT raw_without_checkpoint.item_id,
    raw_without_checkpoint.location_id,
    raw_without_checkpoint.lot_id,
    raw_without_checkpoint.condition,
    raw_without_checkpoint.container_hive_id,
    raw_without_checkpoint.on_hand
   FROM raw_without_checkpoint;


--
-- Name: apiaries apiaries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER apiaries_updated_at BEFORE UPDATE ON public.apiaries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: apiary_memberships apiary_memberships_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER apiary_memberships_updated_at BEFORE UPDATE ON public.apiary_memberships FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: app_users app_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_users_updated_at BEFORE UPDATE ON public.app_users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: bottling_runs bottling_runs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bottling_runs_updated_at BEFORE UPDATE ON public.bottling_runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: catch_boxes catch_boxes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catch_boxes_updated_at BEFORE UPDATE ON public.catch_boxes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: colony_intakes colony_intakes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER colony_intakes_updated_at BEFORE UPDATE ON public.colony_intakes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: consignment_settlements consignment_settlements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER consignment_settlements_updated_at BEFORE UPDATE ON public.consignment_settlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customers customers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deadout_autopsies deadout_autopsies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deadout_autopsies_updated_at BEFORE UPDATE ON public.deadout_autopsies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: equipment_types equipment_types_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER equipment_types_updated_at BEFORE UPDATE ON public.equipment_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: expenses expenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: external_sync external_sync_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER external_sync_updated_at BEFORE UPDATE ON public.external_sync FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: field_incidents field_incidents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER field_incidents_updated_at BEFORE UPDATE ON public.field_incidents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: gnucash_sync_settings gnucash_sync_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER gnucash_sync_settings_updated_at BEFORE UPDATE ON public.gnucash_sync_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: harvest_lots harvest_lots_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER harvest_lots_updated_at BEFORE UPDATE ON public.harvest_lots FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: harvest_sessions harvest_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER harvest_sessions_updated_at BEFORE UPDATE ON public.harvest_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: hives hives_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hives_updated_at BEFORE UPDATE ON public.hives FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: honey_harvests honey_harvests_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER honey_harvests_updated_at BEFORE UPDATE ON public.honey_harvests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sale_items honey_sale_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER honey_sale_items_updated_at BEFORE UPDATE ON public.sale_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sales honey_sales_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER honey_sales_updated_at BEFORE UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: honey_varietals honey_varietals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER honey_varietals_updated_at BEFORE UPDATE ON public.honey_varietals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inspections inspections_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inspections_updated_at BEFORE UPDATE ON public.inspections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_balance_checkpoints_updated_at BEFORE UPDATE ON public.inventory_balance_checkpoints FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_bom_lines inventory_bom_lines_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_bom_lines_updated_at BEFORE UPDATE ON public.inventory_bom_lines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_boms inventory_boms_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_boms_updated_at BEFORE UPDATE ON public.inventory_boms FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: hives inventory_hive_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_hive_delete_guard BEFORE DELETE ON public.hives FOR EACH ROW EXECUTE FUNCTION public.inventory_hive_delete_guard();


--
-- Name: inventory_items inventory_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_locations inventory_locations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_locations_updated_at BEFORE UPDATE ON public.inventory_locations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_lots inventory_lots_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_lots_updated_at BEFORE UPDATE ON public.inventory_lots FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: inventory_movements inventory_movement_scale_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_movement_scale_guard BEFORE INSERT ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.inventory_movement_scale_guard();


--
-- Name: jar_sizes jar_sizes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jar_sizes_updated_at BEFORE UPDATE ON public.jar_sizes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_files media_files_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_files_updated_at BEFORE UPDATE ON public.media_files FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: mite_counts mite_counts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mite_counts_updated_at BEFORE UPDATE ON public.mite_counts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: offline_mutation_receipts offline_mutation_receipts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offline_mutation_receipts_updated_at BEFORE UPDATE ON public.offline_mutation_receipts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: photos photos_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER photos_updated_at BEFORE UPDATE ON public.photos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_batches product_batches_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_batches_updated_at BEFORE UPDATE ON public.product_batches FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_catalog product_catalog_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_catalog_updated_at BEFORE UPDATE ON public.product_catalog FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: propolis_harvests propolis_harvests_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propolis_harvests_updated_at BEFORE UPDATE ON public.propolis_harvests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: queens queens_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queens_updated_at BEFORE UPDATE ON public.queens FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: treatment_products treatment_products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER treatment_products_updated_at BEFORE UPDATE ON public.treatment_products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_settings user_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: wholesale_price_list_items wholesale_price_list_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wholesale_price_list_items_updated_at BEFORE UPDATE ON public.wholesale_price_list_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: wholesale_price_lists wholesale_price_lists_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wholesale_price_lists_updated_at BEFORE UPDATE ON public.wholesale_price_lists FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: yard_labor_sessions yard_labor_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER yard_labor_sessions_updated_at BEFORE UPDATE ON public.yard_labor_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: yard_scales yard_scales_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER yard_scales_updated_at BEFORE UPDATE ON public.yard_scales FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_recommendations ai_recommendations_dismissed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recommendations
    ADD CONSTRAINT ai_recommendations_dismissed_by_fkey FOREIGN KEY (dismissed_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: ai_recommendations ai_recommendations_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_recommendations
    ADD CONSTRAINT ai_recommendations_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: apiary_memberships apiary_memberships_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apiary_memberships
    ADD CONSTRAINT apiary_memberships_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: apiary_memberships apiary_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apiary_memberships
    ADD CONSTRAINT apiary_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: apiary_weather_cache apiary_weather_cache_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apiary_weather_cache
    ADD CONSTRAINT apiary_weather_cache_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: bloom_observations bloom_observations_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bloom_observations
    ADD CONSTRAINT bloom_observations_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id);


--
-- Name: bottling_runs bottling_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bottling_runs
    ADD CONSTRAINT bottling_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: bottling_runs bottling_runs_jar_size_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bottling_runs
    ADD CONSTRAINT bottling_runs_jar_size_id_fkey FOREIGN KEY (jar_size_id) REFERENCES public.jar_sizes(id);


--
-- Name: bottling_runs bottling_runs_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bottling_runs
    ADD CONSTRAINT bottling_runs_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.harvest_lots(id) ON DELETE CASCADE;


--
-- Name: bottling_runs bottling_runs_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bottling_runs
    ADD CONSTRAINT bottling_runs_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: catch_boxes catch_boxes_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catch_boxes
    ADD CONSTRAINT catch_boxes_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: catch_boxes catch_boxes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catch_boxes
    ADD CONSTRAINT catch_boxes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: catch_boxes catch_boxes_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catch_boxes
    ADD CONSTRAINT catch_boxes_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: catch_boxes catch_boxes_occupied_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catch_boxes
    ADD CONSTRAINT catch_boxes_occupied_hive_id_fkey FOREIGN KEY (occupied_hive_id) REFERENCES public.hives(id) ON DELETE SET NULL;


--
-- Name: colony_intakes colony_intakes_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE RESTRICT;


--
-- Name: colony_intakes colony_intakes_catch_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_catch_box_id_fkey FOREIGN KEY (catch_box_id) REFERENCES public.catch_boxes(id) ON DELETE SET NULL;


--
-- Name: colony_intakes colony_intakes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: colony_intakes colony_intakes_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE RESTRICT;


--
-- Name: colony_intakes colony_intakes_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE RESTRICT;


--
-- Name: colony_intakes colony_intakes_queen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_queen_id_fkey FOREIGN KEY (queen_id) REFERENCES public.queens(id) ON DELETE SET NULL;


--
-- Name: colony_intakes colony_intakes_source_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.colony_intakes
    ADD CONSTRAINT colony_intakes_source_hive_id_fkey FOREIGN KEY (source_hive_id) REFERENCES public.hives(id) ON DELETE SET NULL;


--
-- Name: consignment_settlements consignment_settlements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_settlements
    ADD CONSTRAINT consignment_settlements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: consignment_settlements consignment_settlements_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_settlements
    ADD CONSTRAINT consignment_settlements_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;


--
-- Name: consignment_settlements consignment_settlements_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consignment_settlements
    ADD CONSTRAINT consignment_settlements_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: customers customers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: deadout_autopsies deadout_autopsies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadout_autopsies
    ADD CONSTRAINT deadout_autopsies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: deadout_autopsies deadout_autopsies_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadout_autopsies
    ADD CONSTRAINT deadout_autopsies_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE CASCADE;


--
-- Name: equipment_types equipment_types_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: equipment_types equipment_types_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id) ON DELETE RESTRICT;


--
-- Name: equipment_types equipment_types_variant_of_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_variant_of_type_id_fkey FOREIGN KEY (variant_of_type_id) REFERENCES public.equipment_types(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_harvest_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_harvest_lot_id_fkey FOREIGN KEY (harvest_lot_id) REFERENCES public.harvest_lots(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE SET NULL;


--
-- Name: feeding_status_backfills feeding_status_backfills_feeding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeding_status_backfills
    ADD CONSTRAINT feeding_status_backfills_feeding_id_fkey FOREIGN KEY (feeding_id) REFERENCES public.feedings(id) ON DELETE CASCADE;


--
-- Name: feedings feedings_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: feedings feedings_refill_of_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_refill_of_id_fkey FOREIGN KEY (refill_of_id) REFERENCES public.feedings(id);


--
-- Name: feedings feedings_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;


--
-- Name: feedings feedings_source_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_source_media_file_id_fkey FOREIGN KEY (source_media_file_id) REFERENCES public.media_files(id);


--
-- Name: feedings feedings_source_transcript_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_source_transcript_version_id_fkey FOREIGN KEY (source_transcript_version_id) REFERENCES public.transcript_versions(id);


--
-- Name: feedings feedings_status_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedings
    ADD CONSTRAINT feedings_status_changed_by_fkey FOREIGN KEY (status_changed_by) REFERENCES public.app_users(id);


--
-- Name: field_incidents field_incidents_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_incidents
    ADD CONSTRAINT field_incidents_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: field_incidents field_incidents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_incidents
    ADD CONSTRAINT field_incidents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: field_incidents field_incidents_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_incidents
    ADD CONSTRAINT field_incidents_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: field_incidents field_incidents_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_incidents
    ADD CONSTRAINT field_incidents_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE CASCADE;


--
-- Name: harvest_lot_harvests harvest_lot_harvests_harvest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lot_harvests
    ADD CONSTRAINT harvest_lot_harvests_harvest_id_fkey FOREIGN KEY (harvest_id) REFERENCES public.honey_harvests(id) ON DELETE CASCADE;


--
-- Name: harvest_lot_harvests harvest_lot_harvests_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lot_harvests
    ADD CONSTRAINT harvest_lot_harvests_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.harvest_lots(id) ON DELETE CASCADE;


--
-- Name: harvest_lot_photos harvest_lot_photos_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lot_photos
    ADD CONSTRAINT harvest_lot_photos_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.harvest_lots(id) ON DELETE CASCADE;


--
-- Name: harvest_lot_photos harvest_lot_photos_photo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lot_photos
    ADD CONSTRAINT harvest_lot_photos_photo_id_fkey FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE RESTRICT;


--
-- Name: harvest_lots harvest_lots_claim_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_claim_apiary_id_fkey FOREIGN KEY (claim_apiary_id) REFERENCES public.apiaries(id) ON DELETE SET NULL;


--
-- Name: harvest_lots harvest_lots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: harvest_lots harvest_lots_inventory_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_inventory_lot_id_fkey FOREIGN KEY (inventory_lot_id) REFERENCES public.inventory_lots(id) ON DELETE RESTRICT;


--
-- Name: harvest_lots harvest_lots_moisture_override_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_moisture_override_by_fkey FOREIGN KEY (moisture_override_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: harvest_lots harvest_lots_varietal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_lots
    ADD CONSTRAINT harvest_lots_varietal_id_fkey FOREIGN KEY (varietal_id) REFERENCES public.honey_varietals(id) ON DELETE SET NULL;


--
-- Name: harvest_session_true_ups harvest_session_true_ups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_session_true_ups
    ADD CONSTRAINT harvest_session_true_ups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: harvest_session_true_ups harvest_session_true_ups_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_session_true_ups
    ADD CONSTRAINT harvest_session_true_ups_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.harvest_sessions(id) ON DELETE CASCADE;


--
-- Name: harvest_sessions harvest_sessions_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_sessions
    ADD CONSTRAINT harvest_sessions_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id);


--
-- Name: harvest_sessions harvest_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harvest_sessions
    ADD CONSTRAINT harvest_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: hive_location_history hive_location_history_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hive_location_history
    ADD CONSTRAINT hive_location_history_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id);


--
-- Name: hive_location_history hive_location_history_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hive_location_history
    ADD CONSTRAINT hive_location_history_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: hive_splits hive_splits_child_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hive_splits
    ADD CONSTRAINT hive_splits_child_hive_id_fkey FOREIGN KEY (child_hive_id) REFERENCES public.hives(id);


--
-- Name: hive_splits hive_splits_parent_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hive_splits
    ADD CONSTRAINT hive_splits_parent_hive_id_fkey FOREIGN KEY (parent_hive_id) REFERENCES public.hives(id);


--
-- Name: hives hives_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hives
    ADD CONSTRAINT hives_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id);


--
-- Name: hives hives_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hives
    ADD CONSTRAINT hives_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;


--
-- Name: honey_harvests honey_harvests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_harvests
    ADD CONSTRAINT honey_harvests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: honey_harvests honey_harvests_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_harvests
    ADD CONSTRAINT honey_harvests_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: honey_harvests honey_harvests_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_harvests
    ADD CONSTRAINT honey_harvests_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: honey_harvests honey_harvests_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_harvests
    ADD CONSTRAINT honey_harvests_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.harvest_sessions(id);


--
-- Name: sale_items honey_sale_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT honey_sale_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: sale_items honey_sale_items_jar_size_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT honey_sale_items_jar_size_id_fkey FOREIGN KEY (jar_size_id) REFERENCES public.jar_sizes(id);


--
-- Name: sale_items honey_sale_items_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT honey_sale_items_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sales honey_sales_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT honey_sales_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: sales honey_sales_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT honey_sales_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: sales honey_sales_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT honey_sales_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: sales honey_sales_harvest_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT honey_sales_harvest_lot_id_fkey FOREIGN KEY (harvest_lot_id) REFERENCES public.harvest_lots(id) ON DELETE SET NULL;


--
-- Name: sales honey_sales_wholesale_price_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT honey_sales_wholesale_price_list_id_fkey FOREIGN KEY (wholesale_price_list_id) REFERENCES public.wholesale_price_lists(id) ON DELETE SET NULL;


--
-- Name: honey_varietals honey_varietals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.honey_varietals
    ADD CONSTRAINT honey_varietals_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: immich_timeline_candidates immich_timeline_candidates_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_candidates
    ADD CONSTRAINT immich_timeline_candidates_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: immich_timeline_candidates immich_timeline_candidates_last_seen_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_candidates
    ADD CONSTRAINT immich_timeline_candidates_last_seen_scan_id_fkey FOREIGN KEY (last_seen_scan_id) REFERENCES public.immich_timeline_scans(id) ON DELETE SET NULL;


--
-- Name: immich_timeline_candidates immich_timeline_candidates_photo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_candidates
    ADD CONSTRAINT immich_timeline_candidates_photo_id_fkey FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE SET NULL;


--
-- Name: immich_timeline_scans immich_timeline_scans_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immich_timeline_scans
    ADD CONSTRAINT immich_timeline_scans_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: inspections inspections_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT inspections_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: inspections inspections_source_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT inspections_source_media_file_id_fkey FOREIGN KEY (source_media_file_id) REFERENCES public.media_files(id);


--
-- Name: inspections inspections_source_transcript_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT inspections_source_transcript_version_id_fkey FOREIGN KEY (source_transcript_version_id) REFERENCES public.transcript_versions(id);


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_as_of_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_as_of_operation_id_fkey FOREIGN KEY (as_of_operation_id) REFERENCES public.inventory_operations(id) ON DELETE RESTRICT;


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_condition_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_condition_fkey FOREIGN KEY (condition) REFERENCES public.inventory_conditions(condition);


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_container_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_container_hive_id_fkey FOREIGN KEY (container_hive_id) REFERENCES public.hives(id) ON DELETE SET NULL;


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id);


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inventory_locations(id);


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.inventory_lots(id);


--
-- Name: inventory_balance_checkpoints inventory_balance_checkpoints_lot_id_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_balance_checkpoints
    ADD CONSTRAINT inventory_balance_checkpoints_lot_id_item_id_fkey FOREIGN KEY (lot_id, item_id) REFERENCES public.inventory_lots(id, item_id) ON DELETE RESTRICT;


--
-- Name: inventory_bom_lines inventory_bom_lines_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_bom_lines
    ADD CONSTRAINT inventory_bom_lines_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES public.inventory_boms(id) ON DELETE CASCADE;


--
-- Name: inventory_bom_lines inventory_bom_lines_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_bom_lines
    ADD CONSTRAINT inventory_bom_lines_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_bom_lines inventory_bom_lines_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_bom_lines
    ADD CONSTRAINT inventory_bom_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id);


--
-- Name: inventory_boms inventory_boms_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_boms
    ADD CONSTRAINT inventory_boms_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_boms inventory_boms_output_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_boms
    ADD CONSTRAINT inventory_boms_output_item_id_fkey FOREIGN KEY (output_item_id) REFERENCES public.inventory_items(id);


--
-- Name: inventory_items inventory_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_items inventory_items_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_kind_fkey FOREIGN KEY (kind) REFERENCES public.inventory_item_kinds(kind);


--
-- Name: inventory_locations inventory_locations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_locations inventory_locations_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_kind_fkey FOREIGN KEY (kind) REFERENCES public.inventory_location_kinds(kind);


--
-- Name: inventory_locations inventory_locations_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.inventory_locations(id) ON DELETE RESTRICT;


--
-- Name: inventory_locations inventory_locations_wholesale_price_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_locations
    ADD CONSTRAINT inventory_locations_wholesale_price_list_id_fkey FOREIGN KEY (wholesale_price_list_id) REFERENCES public.wholesale_price_lists(id) ON DELETE SET NULL;


--
-- Name: inventory_lots inventory_lots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_lots
    ADD CONSTRAINT inventory_lots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_lots inventory_lots_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_lots
    ADD CONSTRAINT inventory_lots_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id);


--
-- Name: inventory_movements inventory_movements_condition_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_condition_fkey FOREIGN KEY (condition) REFERENCES public.inventory_conditions(condition);


--
-- Name: inventory_movements inventory_movements_container_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_container_hive_id_fkey FOREIGN KEY (container_hive_id) REFERENCES public.hives(id) ON DELETE SET NULL;


--
-- Name: inventory_movements inventory_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_movements inventory_movements_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id);


--
-- Name: inventory_movements inventory_movements_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.inventory_locations(id);


--
-- Name: inventory_movements inventory_movements_lot_id_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_lot_id_item_id_fkey FOREIGN KEY (lot_id, item_id) REFERENCES public.inventory_lots(id, item_id) ON DELETE RESTRICT;


--
-- Name: inventory_movements inventory_movements_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.inventory_operations(id) ON DELETE RESTRICT;


--
-- Name: inventory_operations inventory_operations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operations
    ADD CONSTRAINT inventory_operations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: inventory_operations inventory_operations_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operations
    ADD CONSTRAINT inventory_operations_kind_fkey FOREIGN KEY (kind) REFERENCES public.inventory_operation_kinds(kind);


--
-- Name: inventory_operations inventory_operations_reason_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operations
    ADD CONSTRAINT inventory_operations_reason_fkey FOREIGN KEY (reason) REFERENCES public.inventory_operation_reasons(reason);


--
-- Name: inventory_operations inventory_operations_reverses_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_operations
    ADD CONSTRAINT inventory_operations_reverses_operation_id_fkey FOREIGN KEY (reverses_operation_id) REFERENCES public.inventory_operations(id) ON DELETE RESTRICT;


--
-- Name: jar_serials jar_serials_bottling_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_serials
    ADD CONSTRAINT jar_serials_bottling_run_id_fkey FOREIGN KEY (bottling_run_id) REFERENCES public.bottling_runs(id) ON DELETE CASCADE;


--
-- Name: jar_serials jar_serials_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_serials
    ADD CONSTRAINT jar_serials_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: jar_serials jar_serials_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_serials
    ADD CONSTRAINT jar_serials_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT;


--
-- Name: jar_sizes jar_sizes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_sizes
    ADD CONSTRAINT jar_sizes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: jar_sizes jar_sizes_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_sizes
    ADD CONSTRAINT jar_sizes_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id) ON DELETE RESTRICT;


--
-- Name: jar_sizes jar_sizes_packaging_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jar_sizes
    ADD CONSTRAINT jar_sizes_packaging_type_id_fkey FOREIGN KEY (packaging_type_id) REFERENCES public.equipment_types(id) ON DELETE SET NULL;


--
-- Name: mite_counts mite_counts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: mite_counts mite_counts_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: mite_counts mite_counts_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE CASCADE;


--
-- Name: mite_counts mite_counts_inspection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES public.inspections(id) ON DELETE SET NULL;


--
-- Name: mite_counts mite_counts_source_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_source_media_file_id_fkey FOREIGN KEY (source_media_file_id) REFERENCES public.media_files(id);


--
-- Name: mite_counts mite_counts_source_transcript_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mite_counts
    ADD CONSTRAINT mite_counts_source_transcript_version_id_fkey FOREIGN KEY (source_transcript_version_id) REFERENCES public.transcript_versions(id);


--
-- Name: offline_mutation_receipts offline_mutation_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_mutation_receipts
    ADD CONSTRAINT offline_mutation_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: oidc_identities oidc_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_identities
    ADD CONSTRAINT oidc_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: product_batch_expenses product_batch_expenses_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batch_expenses
    ADD CONSTRAINT product_batch_expenses_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.product_batches(id) ON DELETE CASCADE;


--
-- Name: product_batch_expenses product_batch_expenses_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batch_expenses
    ADD CONSTRAINT product_batch_expenses_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE RESTRICT;


--
-- Name: product_batches product_batches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: product_batches product_batches_harvest_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_harvest_lot_id_fkey FOREIGN KEY (harvest_lot_id) REFERENCES public.harvest_lots(id);


--
-- Name: product_batches product_batches_inventory_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_inventory_lot_id_fkey FOREIGN KEY (inventory_lot_id) REFERENCES public.inventory_lots(id) ON DELETE RESTRICT;


--
-- Name: product_batches product_batches_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product_catalog(id);


--
-- Name: product_batches product_batches_propolis_harvest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_propolis_harvest_id_fkey FOREIGN KEY (propolis_harvest_id) REFERENCES public.propolis_harvests(id);


--
-- Name: product_batches product_batches_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_batches
    ADD CONSTRAINT product_batches_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: product_catalog product_catalog_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: product_catalog product_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id) ON DELETE RESTRICT;


--
-- Name: propolis_harvests propolis_harvests_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propolis_harvests
    ADD CONSTRAINT propolis_harvests_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id);


--
-- Name: propolis_harvests propolis_harvests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propolis_harvests
    ADD CONSTRAINT propolis_harvests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: propolis_harvests propolis_harvests_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propolis_harvests
    ADD CONSTRAINT propolis_harvests_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: propolis_harvests propolis_harvests_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propolis_harvests
    ADD CONSTRAINT propolis_harvests_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: queen_events queen_events_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queen_events
    ADD CONSTRAINT queen_events_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE CASCADE;


--
-- Name: queen_events queen_events_queen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queen_events
    ADD CONSTRAINT queen_events_queen_id_fkey FOREIGN KEY (queen_id) REFERENCES public.queens(id) ON DELETE SET NULL;


--
-- Name: queens queens_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queens
    ADD CONSTRAINT queens_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: queens queens_mated_at_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queens
    ADD CONSTRAINT queens_mated_at_apiary_id_fkey FOREIGN KEY (mated_at_apiary_id) REFERENCES public.apiaries(id) ON DELETE SET NULL;


--
-- Name: queens queens_origin_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queens
    ADD CONSTRAINT queens_origin_hive_id_fkey FOREIGN KEY (origin_hive_id) REFERENCES public.hives(id);


--
-- Name: queens queens_parent_queen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queens
    ADD CONSTRAINT queens_parent_queen_id_fkey FOREIGN KEY (parent_queen_id) REFERENCES public.queens(id);


--
-- Name: sale_items sale_items_bottling_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_bottling_run_id_fkey FOREIGN KEY (bottling_run_id) REFERENCES public.bottling_runs(id) ON DELETE RESTRICT;


--
-- Name: sale_items sale_items_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id);


--
-- Name: sale_items sale_items_inventory_lot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_inventory_lot_id_fkey FOREIGN KEY (inventory_lot_id) REFERENCES public.inventory_lots(id) ON DELETE RESTRICT;


--
-- Name: sale_items sale_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inventory_items(id) ON DELETE RESTRICT;


--
-- Name: sale_items sale_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product_catalog(id);


--
-- Name: scale_readings scale_readings_scale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scale_readings
    ADD CONSTRAINT scale_readings_scale_id_fkey FOREIGN KEY (scale_id) REFERENCES public.yard_scales(id) ON DELETE CASCADE;


--
-- Name: transcript_versions transcript_versions_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_versions
    ADD CONSTRAINT transcript_versions_media_file_id_fkey FOREIGN KEY (media_file_id) REFERENCES public.media_files(id) ON DELETE CASCADE;


--
-- Name: treatment_events treatment_events_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: treatment_events treatment_events_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE CASCADE;


--
-- Name: treatment_events treatment_events_inspection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES public.inspections(id) ON DELETE SET NULL;


--
-- Name: treatment_events treatment_events_source_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_source_media_file_id_fkey FOREIGN KEY (source_media_file_id) REFERENCES public.media_files(id);


--
-- Name: treatment_events treatment_events_source_transcript_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_source_transcript_version_id_fkey FOREIGN KEY (source_transcript_version_id) REFERENCES public.transcript_versions(id);


--
-- Name: user_settings user_settings_default_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_default_apiary_id_fkey FOREIGN KEY (default_apiary_id) REFERENCES public.apiaries(id);


--
-- Name: wholesale_price_list_items wholesale_price_list_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_list_items
    ADD CONSTRAINT wholesale_price_list_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: wholesale_price_list_items wholesale_price_list_items_jar_size_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_list_items
    ADD CONSTRAINT wholesale_price_list_items_jar_size_id_fkey FOREIGN KEY (jar_size_id) REFERENCES public.jar_sizes(id) ON DELETE CASCADE;


--
-- Name: wholesale_price_list_items wholesale_price_list_items_price_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_list_items
    ADD CONSTRAINT wholesale_price_list_items_price_list_id_fkey FOREIGN KEY (price_list_id) REFERENCES public.wholesale_price_lists(id) ON DELETE CASCADE;


--
-- Name: wholesale_price_lists wholesale_price_lists_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wholesale_price_lists
    ADD CONSTRAINT wholesale_price_lists_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: yard_labor_sessions yard_labor_sessions_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_labor_sessions
    ADD CONSTRAINT yard_labor_sessions_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id);


--
-- Name: yard_labor_sessions yard_labor_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_labor_sessions
    ADD CONSTRAINT yard_labor_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: yard_labor_sessions yard_labor_sessions_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_labor_sessions
    ADD CONSTRAINT yard_labor_sessions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: yard_scales yard_scales_apiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_scales
    ADD CONSTRAINT yard_scales_apiary_id_fkey FOREIGN KEY (apiary_id) REFERENCES public.apiaries(id) ON DELETE CASCADE;


--
-- Name: yard_scales yard_scales_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_scales
    ADD CONSTRAINT yard_scales_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: yard_scales yard_scales_hive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yard_scales
    ADD CONSTRAINT yard_scales_hive_id_fkey FOREIGN KEY (hive_id) REFERENCES public.hives(id) ON DELETE SET NULL;

--
-- Seeds. Everything below is data the old chain left on a fresh database:
-- the inventory registries and singleton rows (legacy 00050, verbatim), the
-- treatment withdrawal catalog (legacy 00019 as amended by 00034), and the
-- generation stamp. The chain's other INSERTs were backfills over existing
-- rows (app_users from oidc_identities, honey_varietals from harvest_lots,
-- feeding_status_backfills, transcript_versions) and produce nothing on a
-- fresh database, so they have no baseline equivalent.
--

INSERT INTO inventory_item_kinds (kind, description, unit_family) VALUES
  ('honey_bulk', 'Bulk honey', 'mass'),
  ('jar', 'Filled honey jar', 'count'),
  ('catalog_product', 'Finished catalog product', 'count'),
  ('propolis_raw', 'Raw propolis', 'mass'),
  ('equipment', 'Beekeeping equipment', 'count'),
  ('packaging', 'Packaging material', 'count');

INSERT INTO inventory_location_kinds (kind, description) VALUES
  ('site', 'Physical site'),
  ('storage_area', 'Storage area'),
  ('apiary', 'Apiary'),
  ('consignee', 'Consignment location'),
  ('in_transit', 'Goods in transit'),
  ('deployed', 'Virtual location for hive-deployed stock');

INSERT INTO inventory_operation_kinds (kind, description, sided) VALUES
  ('receive', 'Receipt into inventory', 'one'),
  ('opening_balance', 'Imported opening balance', 'one'),
  ('transfer', 'Location-to-location transfer', 'paired'),
  ('deploy', 'Deploy stock to a hive', 'paired'),
  ('return', 'Return stock from a hive', 'paired'),
  ('transform', 'Consume inputs and produce outputs', 'transform'),
  ('sale_consume', 'Physical sale consumption', 'one'),
  ('sale_return', 'Physical sale return', 'one'),
  ('shrink', 'Loss or other shrink', 'one'),
  ('count_adjust', 'Physical count adjustment', 'one'),
  ('condition_change', 'Move stock between conditions', 'paired'),
  ('reversal', 'Exact negation of an operation', 'paired');

INSERT INTO inventory_conditions (condition, description, sellable) VALUES
  ('serviceable', 'Available for service or sale', true),
  ('damaged', 'Damaged and unavailable for ordinary use', false),
  ('retired', 'Retired from service', false);

INSERT INTO inventory_operation_reasons (reason, description, applies_to_kinds) VALUES
  ('none', 'No additional reason applies', ARRAY['receive','opening_balance','transfer','deploy','return','transform','sale_consume','sale_return','reversal']),
  ('give_away', 'Given away', ARRAY['shrink']),
  ('loss', 'Lost or destroyed', ARRAY['shrink']),
  ('feeding', 'Consumed as bee feed', ARRAY['shrink','transform']),
  ('settlement_shrink', 'Consignee-reported shrink', ARRAY['shrink']),
  ('count', 'Physical count correction', ARRAY['count_adjust']),
  ('packaging_consumed_untraced', 'Packaging consumption without a traced BOM line', ARRAY['shrink','transform']),
  ('damage', 'Changed to damaged condition', ARRAY['condition_change']),
  ('retire', 'Changed to retired condition', ARRAY['condition_change']),
  ('repair', 'Returned to serviceable condition', ARRAY['condition_change']);

INSERT INTO inventory_items
  (id, kind, name, canonical_unit, quantity_scale, lot_tracked, condition_tracked, container_tracked)
VALUES
  ('00000000-0000-0000-0000-000000000101', 'honey_bulk', 'Bulk honey', 'lb', 4, true, false, false),
  ('00000000-0000-0000-0000-000000000102', 'propolis_raw', 'Raw propolis', 'g', 4, true, false, false);

INSERT INTO inventory_locations (id, kind, name, is_home)
VALUES ('00000000-0000-0000-0000-000000000201', 'site', 'Home', true);

INSERT INTO inventory_locations (id, kind, name)
VALUES ('00000000-0000-0000-0000-000000000202', 'deployed', 'Deployed');

-- Treatment withdrawal catalog (legacy 00019 seed as amended by 00034).
-- Regenerated from the migrated scratch database, so the amendments are
-- already folded in; ids and timestamps stay defaulted exactly as the old
-- chain left them.
INSERT INTO public.treatment_products (name, aliases, withdrawal_days, notes) VALUES
  ('ApiLife Var', ARRAY['apilife', 'apilife var']::text[], 30, 'Label: do not use within 30 days of a honey flow; remove before supering.'),
  ('Apiguard', ARRAY['thymol']::text[], 0, 'Label basis: remove honey supers before treating; no post-removal interval stated, so 0 days after removal.'),
  ('Apistan', ARRAY['fluvalinate']::text[], 0, NULL),
  ('Apivar', ARRAY['amitraz', 'apivar strips']::text[], 14, 'Do not harvest while strips are in. Zero days after removal. Label: honey supers may go back on 14 days after strips are removed.'),
  ('Bayvarol', ARRAY['flumethrin']::text[], 0, 'Label basis: remove strips before honey supers go on; no post-removal interval stated, so 0 days.'),
  ('Certan', ARRAY['b401', 'b-401', 'bacillus thuringiensis aizawai']::text[], 0, 'Label basis: no honey withdrawal, so 0 days.'),
  ('CheckMite+', ARRAY['checkmite', 'checkmite+', 'coumaphos']::text[], 14, 'Label: honey supers may go back on 14 days after strips are removed.'),
  ('Formic Pro', ARRAY['formic acid', 'maqs', 'mite away', 'mite-away']::text[], 0, 'Some labels allow harvest during treatment. Record date_removed to clear the lock. Label basis: honey supers may remain on during treatment, so 0 days.'),
  ('Fumagilin-B', ARRAY['fumagillin', 'fumidil']::text[], 0, 'Label basis: feed with honey supers off; no post-removal interval stated, so 0 days.'),
  ('HopGuard', ARRAY['hopguard 3', 'hops beta acids']::text[], 0, 'Label basis: HopGuard 3 may be used with honey supers on; no withdrawal stated, so 0 days.'),
  ('Lincomix', ARRAY['lincomycin']::text[], 28, 'Label basis: do not use within 4 weeks (28 days) of the main honey flow.'),
  ('Oxalic acid', ARRAY['oa', 'oa vapor', 'oa dribble', 'oxalic']::text[], 0, 'One-shot: set date_removed to the application date. Label basis: not for use with honey supers in place; no post-removal interval stated, so 0 days after the application date.'),
  ('Para-Moth', ARRAY['paradichlorobenzene', 'pdb', 'moth crystals']::text[], 0, 'Stored-comb fumigant, not a colony treatment: air combs thoroughly before use. No honey withdrawal, so 0 days.'),
  ('Terramycin', ARRAY['oxytetracycline', 'terramycin ts', 'tm-50']::text[], 42, 'Label basis: discontinue at least 6 weeks (42 days) before the main honey flow.'),
  ('Thymovar', ARRAY['thymol strips']::text[], 30, 'Label ambiguous on a post-removal interval; conservative default matched to ApiLife Var (thymol, 30 days). Verify against the label in hand.'),
  ('Tylan', ARRAY['tylosin', 'tylosin tartrate']::text[], 28, 'Label basis: do not use within 4 weeks (28 days) of the main honey flow.'),
  ('VarroxSan', ARRAY['oxalic strips', 'extended release oxalic']::text[], 0, 'Label basis: remove strips before adding honey supers; no post-removal interval stated, so 0 days.');

-- The generation stamp. 'ledger-v1' was the Phase A chain; a baseline
-- database is a different schema wearing goose version 1, so it is stamped
-- differently and internal/db refuses to mix the two (design review A6).
INSERT INTO public.schema_generation (generation) VALUES ('ledger-v1-baseline');

-- +goose Down
-- A baseline has no predecessor: "down" is a teardown of the whole public
-- schema, which is exactly what recreating a database means in Phase B. It is
-- written as a sweep rather than 72 DROP statements so it cannot drift out of
-- step with the Up above.
-- +goose StatementBegin
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm')
      AND c.relname <> 'goose_db_version'
  LOOP
    IF target.kind = 'r' THEN
      EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', target.name);
    ELSIF target.kind = 'v' THEN
      EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', target.name);
    ELSE
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', target.name);
    END IF;
  END LOOP;
  FOR target IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', target.signature);
  END LOOP;
  FOR target IN
    SELECT t.typname AS name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', target.name);
  END LOOP;
END
$$;
-- +goose StatementEnd
