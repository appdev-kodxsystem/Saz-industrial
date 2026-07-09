-- Make stock_items (purchase / stock-in history) survive product deletion.
-- stock_items.product_id is ON DELETE CASCADE today, so deleting a product wipes
-- its purchase history from the ledger/Purchases page. Snapshot the product
-- details, add user_id for scoping once the product is gone, and switch the FK
-- to ON DELETE SET NULL so the rows are preserved. Additive + idempotent.

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS product_sku text;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS product_image_url text;

-- Backfill existing rows from their product while it still exists.
UPDATE stock_items si
SET user_id = p.user_id,
    product_name = COALESCE(si.product_name, p.name),
    product_sku = COALESCE(si.product_sku, p.sku),
    product_image_url = COALESCE(si.product_image_url, p.image_url)
FROM products p
WHERE si.product_id = p.id
  AND si.user_id IS NULL;

-- Preserve the stock item when its product is deleted.
ALTER TABLE stock_items DROP CONSTRAINT IF EXISTS stock_items_product_id_fkey;
ALTER TABLE stock_items
  ADD CONSTRAINT stock_items_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_items_user_id ON stock_items(user_id);
