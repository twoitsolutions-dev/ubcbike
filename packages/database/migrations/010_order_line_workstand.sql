-- Workstand-owned store: order lines for products that only exist in the Workstand catalog (not in
-- Lightspeed) are recorded for reference as 'workstand_catalog' and never raise an exception.
ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_source_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_source_check CHECK (source IN ('ubc_stock', 'supplier', 'unfulfillable', 'workstand_catalog'));
