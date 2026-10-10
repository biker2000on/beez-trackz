-- +goose Up
-- The business a customer represents. The operator sells to shops, cafes and
-- other businesses, so a customer is often a company with a contact person:
-- company_name is the business, the existing name stays the contact. Nullable:
-- a household customer has no company, and older rows never recorded one.
-- Both chains run this same file.
ALTER TABLE customers ADD COLUMN company_name text;

-- +goose Down
ALTER TABLE customers DROP COLUMN company_name;
