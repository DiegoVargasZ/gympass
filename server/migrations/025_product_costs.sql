-- NULL preserves the distinction between an unknown historical cost and a free product.
ALTER TABLE pos_products ADD COLUMN cost_cents INTEGER CHECK(cost_cents IS NULL OR (typeof(cost_cents)='integer' AND cost_cents BETWEEN 0 AND 1000000000));
ALTER TABLE pos_sale_lines ADD COLUMN cost_cents INTEGER CHECK(cost_cents IS NULL OR (typeof(cost_cents)='integer' AND cost_cents BETWEEN 0 AND 1000000000));
