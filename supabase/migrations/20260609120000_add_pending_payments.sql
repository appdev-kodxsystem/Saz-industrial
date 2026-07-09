-- Pending Payments feature: track partial payments on sales.
-- Purely additive. Existing sales are backfilled as fully paid so they never
-- surface as pending, keeping historical sales/reporting data intact.

-- Net amount actually received from the customer for this sale.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS net_payment numeric NOT NULL DEFAULT 0;

-- Optional customer info captured at sale time.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_contact text;

-- Payment lifecycle: 'pending' while a balance remains, 'completed' once settled.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'completed';

-- Backfill: every pre-existing sale is considered fully paid.
-- Runs only for rows created before this migration (net_payment still at the
-- column default of 0); new rows set their own net_payment via the app.
UPDATE sales SET net_payment = selling_price WHERE net_payment = 0;
UPDATE sales SET payment_status = 'completed' WHERE payment_status IS NULL;

-- Outstanding balance, always derived from selling_price - net_payment so it can
-- never drift out of sync with the source values.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS pending_payment numeric
  GENERATED ALWAYS AS (selling_price - net_payment) STORED;

-- Fast lookup of sales that still owe money.
CREATE INDEX IF NOT EXISTS idx_sales_pending ON sales(payment_status) WHERE payment_status = 'pending';
