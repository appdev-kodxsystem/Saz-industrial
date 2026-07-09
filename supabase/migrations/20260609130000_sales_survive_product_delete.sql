-- Make sales (and their pending payments) survive product deletion.
-- Today sales.product_id is ON DELETE CASCADE, so deleting a product wipes its
-- sales and any outstanding pending payments. We snapshot the product details
-- onto each sale, add user_id for ownership scoping once the product is gone,
-- and switch the FK to ON DELETE SET NULL so the sale row is preserved.
-- Purely additive + idempotent.

-- Ownership + product snapshot captured at sale time.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS product_sku text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS product_image_url text;

-- Backfill existing sales from their product while it still exists.
UPDATE sales s
SET user_id = p.user_id,
    product_name = COALESCE(s.product_name, p.name),
    product_sku = COALESCE(s.product_sku, p.sku),
    product_image_url = COALESCE(s.product_image_url, p.image_url)
FROM products p
WHERE s.product_id = p.id
  AND s.user_id IS NULL;

-- Preserve the sale when its product is deleted (instead of cascading the delete).
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_product_id_fkey;
ALTER TABLE sales
  ADD CONSTRAINT sales_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_user_id ON sales(user_id);
