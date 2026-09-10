-- ---------------------------------------------------------------------------
-- Sale orders — one row per SALE, not per unit sold
-- ---------------------------------------------------------------------------
-- `sales` holds one row per unit, which is right for costing (each unit carries
-- the purchase price of the specific stock item it came from) but wrong for
-- every human-facing surface: a customer who buys three saws made ONE sale, and
-- the ledger listed three. This adds the header the ledger should have been
-- listing all along. `sales` is untouched as the line table.
--
-- Mirrors what stock_orders already is on the purchase side, so both ledgers
-- now read the same way: one row per transaction, click through for the lines.

CREATE TABLE IF NOT EXISTS public.sale_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- audit stamp: who rang it up. SET NULL so the sale outlives the member.
  user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_name    TEXT,
  customer_contact TEXT,
  note             TEXT,
  -- All four are DERIVED from the sales rows underneath by the trigger below,
  -- never written by the app. A header that could drift from its own lines
  -- would be worse than no header at all.
  total_amount     NUMERIC NOT NULL DEFAULT 0,
  net_payment      NUMERIC NOT NULL DEFAULT 0,
  pending_payment  NUMERIC GENERATED ALWAYS AS (total_amount - net_payment) STORED,
  payment_status   TEXT NOT NULL DEFAULT 'completed',
  unit_count       INTEGER NOT NULL DEFAULT 0,
  line_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sale_orders
  ADD COLUMN IF NOT EXISTS org_id           UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_name    TEXT,
  ADD COLUMN IF NOT EXISTS customer_contact TEXT,
  ADD COLUMN IF NOT EXISTS note             TEXT,
  ADD COLUMN IF NOT EXISTS total_amount     NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_payment      NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_payment  NUMERIC GENERATED ALWAYS AS (total_amount - net_payment) STORED,
  ADD COLUMN IF NOT EXISTS payment_status   TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS unit_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- ON DELETE SET NULL, not CASCADE: deleting the header must never delete the
-- sales it grouped — they are the costing record, and may be settled.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.sale_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sales_order_idx           ON public.sales(order_id);
CREATE INDEX IF NOT EXISTS sale_orders_org_idx       ON public.sale_orders(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sale_orders_pending_idx   ON public.sale_orders(org_id, payment_status)
  WHERE payment_status = 'pending';

ALTER TABLE public.sale_orders ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sale_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_orders TO authenticated;
GRANT ALL ON public.sale_orders TO service_role;

DROP POLICY IF EXISTS "Members can view org sale orders"   ON public.sale_orders;
DROP POLICY IF EXISTS "Members can insert org sale orders" ON public.sale_orders;
DROP POLICY IF EXISTS "Members can update org sale orders" ON public.sale_orders;
DROP POLICY IF EXISTS "Admins can delete org sale orders"  ON public.sale_orders;

-- Same split as `sales`: selling is the employee's whole job, so any member may
-- open and update a sale order. Only an admin can erase one.
CREATE POLICY "Members can view org sale orders"
  ON public.sale_orders FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Members can insert org sale orders"
  ON public.sale_orders FOR INSERT
  TO authenticated WITH CHECK (org_id = (select public.current_org_id()));

CREATE POLICY "Members can update org sale orders"
  ON public.sale_orders FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()))
  WITH CHECK (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can delete org sale orders"
  ON public.sale_orders FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));


-- ---------------------------------------------------------------------------
-- Header totals, recomputed from the lines
-- ---------------------------------------------------------------------------
-- The header is a projection of its sales rows and nothing else. Recomputing
-- the whole order on every line change is cheap (an order is a handful of rows)
-- and removes the entire class of bug where a settled payment or a deleted line
-- leaves the ledger showing a number that no longer adds up.
CREATE OR REPLACE FUNCTION public.sale_order_recount(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC;
  v_net   NUMERIC;
  v_units INTEGER;
  v_lines INTEGER;
BEGIN
  IF p_order_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(selling_price), 0),
         COALESCE(SUM(net_payment), 0),
         COUNT(*),
         COUNT(DISTINCT COALESCE(product_id::TEXT, product_sku, id::TEXT))
    INTO v_total, v_net, v_units, v_lines
  FROM public.sales
  WHERE order_id = p_order_id;

  UPDATE public.sale_orders
     SET total_amount   = v_total,
         net_payment    = v_net,
         payment_status = CASE WHEN v_total - v_net > 0 THEN 'pending' ELSE 'completed' END,
         unit_count     = v_units,
         line_count     = v_lines
   WHERE id = p_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sale_order_recount(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sales_touch_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.order_id IS NOT NULL THEN
    PERFORM public.sale_order_recount(OLD.order_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.order_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.order_id IS DISTINCT FROM OLD.order_id
          OR NEW.selling_price IS DISTINCT FROM OLD.selling_price
          OR NEW.net_payment IS DISTINCT FROM OLD.net_payment) THEN
    PERFORM public.sale_order_recount(NEW.order_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sales_touch_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sales_sync_order ON public.sales;
CREATE TRIGGER sales_sync_order
  AFTER INSERT OR UPDATE OR DELETE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.sales_touch_order();


-- ---------------------------------------------------------------------------
-- Backfill: give every pre-existing sale a header
-- ---------------------------------------------------------------------------
-- Rows written by one checkout share an EXACT created_at: they went in as a
-- single INSERT, and now() is the transaction timestamp, not the row's. So
-- (org, member, customer, created_at) reconstructs the original carts exactly
-- rather than approximately. Runs only for sales that have no order yet, so it
-- is safe to re-run.
DO $$
DECLARE
  g RECORD;
  v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales WHERE order_id IS NULL) THEN
    RETURN;
  END IF;

  FOR g IN
    SELECT org_id, user_id, customer_name, customer_contact, created_at
    FROM public.sales
    WHERE order_id IS NULL
    GROUP BY org_id, user_id, customer_name, customer_contact, created_at
  LOOP
    INSERT INTO public.sale_orders (org_id, user_id, customer_name, customer_contact, created_at)
    VALUES (g.org_id, g.user_id, g.customer_name, g.customer_contact, g.created_at)
    RETURNING id INTO v_id;

    UPDATE public.sales
       SET order_id = v_id
     WHERE order_id IS NULL
       AND org_id = g.org_id
       AND user_id IS NOT DISTINCT FROM g.user_id
       AND customer_name IS NOT DISTINCT FROM g.customer_name
       AND customer_contact IS NOT DISTINCT FROM g.customer_contact
       AND created_at = g.created_at;

    PERFORM public.sale_order_recount(v_id);
  END LOOP;
END;
$$;


-- ---------------------------------------------------------------------------
-- Custom add-ons — a one-off extra, not a catalogue item
-- ---------------------------------------------------------------------------
-- At the till you sometimes throw in something that was never stocked as an
-- add-on: a length of cable, a discount-in-kind, a part off the bench. It still
-- costs the org money and still has to come off the profit of the sale it went
-- out on, so it belongs in sale_addons — it just has no catalogue row and no
-- batch to draw down.
--
-- addon_id and batch_id are already nullable, so the only new column is the
-- flag that tells the two kinds apart. The restore-on-delete trigger is a no-op
-- for these (no batch_id), and sale_addon_totals already sums every row, so
-- custom add-ons hit profit through exactly the same path as catalogue ones.
ALTER TABLE public.sale_addons
  ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE;

-- `authenticated` deliberately has no INSERT grant on sale_addons (add-on stock
-- is consumable only through a function that proves the sale exists first), so
-- custom add-ons need their own door with the same proof.
CREATE OR REPLACE FUNCTION public.addon_attach_custom(
  p_sale_id    UUID,
  p_name       TEXT,
  p_qty        INTEGER,
  p_unit_cost  NUMERIC,
  p_list_value NUMERIC DEFAULT 0
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org  UUID;
  v_name TEXT;
BEGIN
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 1000 THEN
    RAISE EXCEPTION 'Add-on quantity must be between 1 and 1000';
  END IF;
  IF p_unit_cost IS NULL OR p_unit_cost < 0 OR p_unit_cost > 1000000 THEN
    RAISE EXCEPTION 'Add-on unit cost is out of range';
  END IF;

  v_name := btrim(COALESCE(p_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'A custom add-on needs a name';
  END IF;
  v_name := left(v_name, 120);

  v_org := public.current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Not a member of any organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sales WHERE id = p_sale_id AND org_id = v_org
  ) THEN
    RAISE EXCEPTION 'An add-on can only go out with a sale in your organization';
  END IF;

  INSERT INTO public.sale_addons (
    sale_id, addon_id, batch_id, org_id, user_id,
    addon_name, addon_code, quantity, unit_cost, list_value, is_custom
  ) VALUES (
    p_sale_id, NULL, NULL, v_org, (select auth.uid()),
    v_name, 'CUSTOM', p_qty, p_unit_cost, GREATEST(COALESCE(p_list_value, 0), 0), TRUE
  );

  RETURN p_qty * p_unit_cost;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.addon_attach_custom(UUID, TEXT, INTEGER, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.addon_attach_custom(UUID, TEXT, INTEGER, NUMERIC, NUMERIC) TO authenticated;

-- Checkout attaches both kinds at once. One call, one transaction: the whole
-- ticket's giveaways land or none of them do.
-- p_lines: [{"sale_id": "...", "addon_id": "...", "qty": 2},
--           {"sale_id": "...", "name": "Cable", "qty": 1, "unit_cost": 250}, …]
CREATE OR REPLACE FUNCTION public.addon_attach_bulk(p_lines JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line  JSONB;
  v_total NUMERIC := 0;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'Expected an array of add-on lines';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'Too many add-on lines in one call';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    -- A line with no addon_id is a one-off typed in at the till.
    IF v_line ? 'addon_id' AND v_line->>'addon_id' IS NOT NULL THEN
      v_total := v_total + public.addon_attach_to_sale(
        (v_line->>'sale_id')::UUID,
        (v_line->>'addon_id')::UUID,
        (v_line->>'qty')::INTEGER
      );
    ELSE
      v_total := v_total + public.addon_attach_custom(
        (v_line->>'sale_id')::UUID,
        (v_line->>'name'),
        (v_line->>'qty')::INTEGER,
        COALESCE((v_line->>'unit_cost')::NUMERIC, 0),
        COALESCE((v_line->>'list_value')::NUMERIC, 0)
      );
    END IF;
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.addon_attach_bulk(JSONB) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.addon_attach_bulk(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
