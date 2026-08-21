-- +goose Up
-- CanvasRegistration offset/rotation/scale is identity once any stand has
-- GPS. Drop the unused satellite overlay key (Leaflet tiles replaced it)
-- and strip the vestigial transform from stored canvas blobs.

ALTER TABLE apiaries DROP COLUMN IF EXISTS satellite_image_key;

UPDATE apiaries
SET canvas_layout = canvas_layout - 'registration'
WHERE jsonb_typeof(canvas_layout) = 'object'
  AND canvas_layout ? 'registration';

-- +goose Down
-- Values are not restorable, by design: satellite_image_key comes back
-- all-NULL and the stripped registration transform was identity everywhere
-- once stands carried GPS. Nothing in pre-00032 code requires either value.
ALTER TABLE apiaries ADD COLUMN satellite_image_key text;
