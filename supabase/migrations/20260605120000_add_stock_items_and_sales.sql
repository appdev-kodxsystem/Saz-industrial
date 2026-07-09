-- Create stock_items table to track individual units by manufacture id
CREATE TABLE IF NOT EXISTS stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  manufacture_id text NOT NULL,
  purchase_price numeric NOT NULL DEFAULT 0,
  sold boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  sold_at timestamptz
);

-- Create sales table to record sales tied to stock_items
CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES stock_items(id) ON DELETE SET NULL,
  selling_price numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookup of next available stock item per product
CREATE INDEX IF NOT EXISTS idx_stock_items_product_created ON stock_items(product_id, created_at) WHERE sold = false;
