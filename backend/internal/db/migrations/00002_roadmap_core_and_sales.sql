-- +goose Up
-- Core apiary analytics and harvest-to-sale records. The migration is
-- additive so existing rewrite data remains valid and deploys can roll
-- forward without a maintenance window.

CREATE TABLE mite_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  inspection_id uuid REFERENCES inspections(id) ON DELETE SET NULL,
  date timestamptz NOT NULL,
  method text NOT NULL CHECK (method IN ('alcohol_wash', 'sugar_roll', 'sticky_board', 'visual')),
  mites_count integer NOT NULL CHECK (mites_count >= 0),
  sample_size integer CHECK (sample_size IS NULL OR sample_size > 0),
  mites_per_100 double precision GENERATED ALWAYS AS (
    CASE
      WHEN sample_size IS NOT NULL THEN mites_count::double precision * 100.0 / sample_size
      ELSE NULL
    END
  ) STORED,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, method)
);
CREATE INDEX mite_counts_hive_date_idx ON mite_counts (hive_id, date DESC);

CREATE TABLE treatment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  inspection_id uuid REFERENCES inspections(id) ON DELETE SET NULL,
  date_applied timestamptz NOT NULL,
  product text NOT NULL,
  method text,
  date_removed timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX treatment_events_hive_date_idx ON treatment_events (hive_id, date_applied DESC);

CREATE TABLE queen_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  queen_id uuid REFERENCES queens(id) ON DELETE SET NULL,
  event_date timestamptz NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('observed', 'introduced', 'superseded', 'missing', 'dead', 'requeened')
  ),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queen_events_hive_date_idx ON queen_events (hive_id, event_date DESC);

CREATE TABLE harvest_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_code text NOT NULL UNIQUE,
  public_slug text NOT NULL UNIQUE,
  extraction_date date NOT NULL,
  honey_weight_lbs double precision NOT NULL CHECK (honey_weight_lbs >= 0),
  honey_variety text,
  season text,
  apiary_region text,
  bloom_notes text,
  beekeeper_story text,
  testing_data jsonb,
  reorder_url text,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER harvest_lots_updated_at BEFORE UPDATE ON harvest_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE harvest_lot_harvests (
  lot_id uuid NOT NULL REFERENCES harvest_lots(id) ON DELETE CASCADE,
  harvest_id uuid NOT NULL REFERENCES honey_harvests(id) ON DELETE CASCADE,
  PRIMARY KEY (lot_id, harvest_id)
);
CREATE INDEX harvest_lot_harvests_harvest_idx ON harvest_lot_harvests (harvest_id);

CREATE TABLE harvest_lot_photos (
  lot_id uuid NOT NULL REFERENCES harvest_lots(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (lot_id, photo_id)
);

CREATE TABLE bottling_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES harvest_lots(id) ON DELETE CASCADE,
  bottled_date date NOT NULL,
  jar_size_id uuid REFERENCES jar_sizes(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  honey_lbs double precision CHECK (honey_lbs IS NULL OR honey_lbs >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bottling_runs_lot_date_idx ON bottling_runs (lot_id, bottled_date DESC);

CREATE TABLE jar_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bottling_run_id uuid NOT NULL REFERENCES bottling_runs(id) ON DELETE CASCADE,
  serial_number text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jar_serials_run_idx ON jar_serials (bottling_run_id);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL,
  category text NOT NULL CHECK (
    category IN (
      'bees_queens', 'feed', 'treatments', 'packaging', 'equipment',
      'mileage', 'market_fees', 'labor', 'other'
    )
  ),
  description text NOT NULL,
  amount double precision NOT NULL CHECK (amount >= 0),
  apiary_id uuid REFERENCES apiaries(id) ON DELETE SET NULL,
  hive_id uuid REFERENCES hives(id) ON DELETE SET NULL,
  harvest_lot_id uuid REFERENCES harvest_lots(id) ON DELETE SET NULL,
  season text,
  vendor text,
  quantity double precision,
  unit text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_date_idx ON expenses (expense_date DESC);
CREATE INDEX expenses_apiary_idx ON expenses (apiary_id);
CREATE INDEX expenses_lot_idx ON expenses (harvest_lot_id);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  phone text,
  notes text,
  email_opt_in boolean NOT NULL DEFAULT false,
  referral_code text UNIQUE,
  referred_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX customers_name_idx ON customers (lower(name));
CREATE UNIQUE INDEX customers_email_lower_idx ON customers (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE wholesale_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  minimum_order_amount double precision NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wholesale_price_list_items (
  price_list_id uuid NOT NULL REFERENCES wholesale_price_lists(id) ON DELETE CASCADE,
  jar_size_id uuid NOT NULL REFERENCES jar_sizes(id) ON DELETE CASCADE,
  unit_price double precision NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (price_list_id, jar_size_id)
);

ALTER TABLE honey_sales
  ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN harvest_lot_id uuid REFERENCES harvest_lots(id) ON DELETE SET NULL,
  ADD COLUMN channel text NOT NULL DEFAULT 'direct' CHECK (
    channel IN ('farm_stand', 'farmers_market', 'wholesale', 'pickup', 'online', 'gift', 'consignment', 'direct')
  ),
  ADD COLUMN payment_method text NOT NULL DEFAULT 'cash' CHECK (
    payment_method IN ('cash', 'card', 'check', 'venmo', 'paypal', 'invoice', 'other')
  ),
  ADD COLUMN discount_amount double precision NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN amount_paid double precision NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  ADD COLUMN order_status text NOT NULL DEFAULT 'paid' CHECK (
    order_status IN ('draft', 'pending', 'paid', 'fulfilled', 'cancelled')
  ),
  ADD COLUMN order_number text,
  ADD COLUMN due_date date,
  ADD COLUMN wholesale_price_list_id uuid REFERENCES wholesale_price_lists(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX honey_sales_order_number_idx ON honey_sales (order_number)
  WHERE order_number IS NOT NULL;
CREATE INDEX honey_sales_channel_date_idx ON honey_sales (channel, date DESC);
CREATE INDEX honey_sales_customer_idx ON honey_sales (customer_id);
CREATE INDEX honey_sales_harvest_lot_idx ON honey_sales (harvest_lot_id);

-- Existing sales predate payment tracking and were paid at entry time.
UPDATE honey_sales SET amount_paid = total_amount;

ALTER TABLE jar_sizes
  ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 6 CHECK (low_stock_threshold >= 0);

-- +goose Down
ALTER TABLE jar_sizes DROP COLUMN IF EXISTS low_stock_threshold;
ALTER TABLE honey_sales
  DROP COLUMN IF EXISTS wholesale_price_list_id,
  DROP COLUMN IF EXISTS due_date,
  DROP COLUMN IF EXISTS order_number,
  DROP COLUMN IF EXISTS order_status,
  DROP COLUMN IF EXISTS amount_paid,
  DROP COLUMN IF EXISTS discount_amount,
  DROP COLUMN IF EXISTS payment_method,
  DROP COLUMN IF EXISTS channel,
  DROP COLUMN IF EXISTS harvest_lot_id,
  DROP COLUMN IF EXISTS customer_id;
DROP TABLE IF EXISTS wholesale_price_list_items, wholesale_price_lists, customers,
  expenses, jar_serials, bottling_runs, harvest_lot_photos, harvest_lot_harvests,
  harvest_lots, queen_events, treatment_events, mite_counts;
