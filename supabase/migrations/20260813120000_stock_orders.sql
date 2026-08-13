-- ============================================================================
-- Stock orders — one supplier run, many products, many units, one receipt.
--
-- Stock used to arrive one product at a time. This groups a whole purchase into
-- a single order row so the receipt photo, the supplier and the total have
-- somewhere to live, and every unit added in that run points back at it.
--
-- Non-destructive: stock_items.order_id is nullable, so every existing unit
-- stays valid with a NULL order.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.stock_orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- audit stamp only; goes NULL if the admin who placed the order is removed.
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  supplier    TEXT,
  note        TEXT,
  -- storage path inside the private `receipts` bucket, NOT a public URL. Read
  -- back through a signed URL — see signStorageUrl in the client.
  receipt_path TEXT,
  total_cost  NUMERIC NOT NULL DEFAULT 0,
  unit_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ON DELETE SET NULL, not CASCADE: deleting an order must never delete the
-- stock units it brought in — they are inventory, and may already be sold.
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.stock_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stock_items_order_idx  ON public.stock_items(order_id);
CREATE INDEX IF NOT EXISTS stock_orders_org_idx   ON public.stock_orders(org_id, created_at DESC);

-- Manufacture ids are generated server-side per product, and the generator
-- picks the next free number by reading the ids already on that product.
CREATE INDEX IF NOT EXISTS stock_items_product_mfr_idx
  ON public.stock_items(product_id, manufacture_id);

-- ---------------------------------------------------------------------------
-- RLS — same split as stock_items: any member reads, only admins write.
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view org stock orders"  ON public.stock_orders;
DROP POLICY IF EXISTS "Admins can insert org stock orders" ON public.stock_orders;
DROP POLICY IF EXISTS "Admins can update org stock orders" ON public.stock_orders;
DROP POLICY IF EXISTS "Admins can delete org stock orders" ON public.stock_orders;

CREATE POLICY "Members can view org stock orders"
  ON public.stock_orders FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can insert org stock orders"
  ON public.stock_orders FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can update org stock orders"
  ON public.stock_orders FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can delete org stock orders"
  ON public.stock_orders FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_orders TO authenticated;
