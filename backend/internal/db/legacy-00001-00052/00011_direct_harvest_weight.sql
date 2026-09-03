-- +goose Up
-- Direct harvested-weight entry (roadmap "harvest entry" polish). A harvest
-- measured on the extracted honey itself — buckets on a scale — has no
-- super-weight pair. Storing it as a synthetic before/after with nothing
-- marking it synthetic made the pair look like a real measurement. The flag
-- keeps the ledger honest: direct rows store the harvested pounds in
-- super_weight_before with after = 0 and render as a direct measurement.
ALTER TABLE honey_harvests
    ADD COLUMN direct_weight boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE honey_harvests DROP COLUMN IF EXISTS direct_weight;
