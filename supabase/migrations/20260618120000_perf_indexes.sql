-- Performance: the ledger / sales / purchases / profit queries all filter by
-- user_id and order by created_at desc. The existing single-column user_id
-- indexes cover the filter but leave the sort to a separate step; these
-- composite indexes let Postgres satisfy filter + order from one index scan.
CREATE INDEX IF NOT EXISTS idx_sales_user_created
  ON sales(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_items_user_created
  ON stock_items(user_id, created_at DESC);
