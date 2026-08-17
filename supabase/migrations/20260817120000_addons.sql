-- ============================================================================
-- Add-ons — free extras handed out with a sold unit, paid for out of margin
-- ============================================================================
-- An add-on is something the organization gives away with a machine: a spare
-- blade, a carry case, an oil bottle, a warranty card. Three rules define it,
-- and all three are enforced here rather than in the UI:
--
--   1. An add-on NEVER changes what the customer pays. sales.selling_price,
--      net_payment and pending_payment are untouched by this migration.
--   2. What the add-on cost the organization is subtracted from the PROFIT of
--      the sale it went out on. sale_addons.total_cost is that number.
--   3. An add-on cannot be sold on its own. sale_addons.sale_id is NOT NULL and
--      `authenticated` has no INSERT grant on the table — the only way to
--      consume add-on stock is addon_attach_to_sale(), which refuses to run
--      unless the sale already exists in the caller's organization.
--
-- Everything about add-ons is its own table. Nothing is bolted onto products,
-- stock_items or sales as a flag or a nullable column.
--
-- Stock model: add-ons are consumables bought in bulk with no serial number, so
-- they are tracked as BATCHES (quantity + remaining + unit_cost) rather than one
-- row per unit like stock_items. Cost stays exact per unit — a batch bought at a
-- different rate is a different batch — without one row per giveaway sticker.
-- On-hand is derived from the batches (see the addon_stock_levels view), so
-- there is no counter that can drift out of step with reality.
--
-- Idempotent: safe to re-run. Never drops a table, never deletes a row.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. addons — the catalogue. One row per kind of add-on the org gives away.
-- ---------------------------------------------------------------------------
-- Mirrors products' ownership model exactly: org_id is the tenant key and the
-- RLS predicate, user_id is an audit stamp that goes NULL if that member is
-- removed — the catalogue belongs to the organization, not to a person.
CREATE TABLE IF NOT EXISTS public.addons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  -- the add-on's SKU. Unique per organization so two admins can't quietly
  -- create two "TK-01"s that later read as the same thing in the ledger.
  code          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'Uncategorized',
  description   TEXT,
  image_url     TEXT,
  -- The default cost of one unit, used to seed the stock-in form. The figure
  -- that actually hits profit is the unit_cost of the batch it came out of.
  unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  -- What the add-on is worth to the customer, for the receipt line
  -- ("free carry case, worth Rs 2,500"). Display only — never charged, never
  -- part of any profit calculation.
  list_value    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (list_value >= 0),
  reorder_at    INTEGER NOT NULL DEFAULT 5 CHECK (reorder_at >= 0),
  -- Retired add-ons stay on old sales but drop out of the sell-time picker.
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS addons_org_code_idx    ON public.addons (org_id, lower(code));
CREATE INDEX        IF NOT EXISTS addons_org_active_idx  ON public.addons (org_id, active, name);

ALTER TABLE public.addons ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.addons FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addons TO authenticated;
GRANT ALL ON public.addons TO service_role;

DROP POLICY IF EXISTS "Members can view org addons"  ON public.addons;
DROP POLICY IF EXISTS "Admins can insert org addons" ON public.addons;
DROP POLICY IF EXISTS "Admins can update org addons" ON public.addons;
DROP POLICY IF EXISTS "Admins can delete org addons" ON public.addons;

-- Same split as products: every member reads the catalogue (an employee needs
-- it to pick an add-on at sale time), only an admin writes it.
CREATE POLICY "Members can view org addons"
  ON public.addons FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can insert org addons"
  ON public.addons FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can update org addons"
  ON public.addons FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can delete org addons"
  ON public.addons FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

DROP TRIGGER IF EXISTS addons_set_updated_at ON public.addons;
CREATE TRIGGER addons_set_updated_at
  BEFORE UPDATE ON public.addons
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 2. addon_stock_batches — one row per lot received, at one price
-- ---------------------------------------------------------------------------
-- `quantity` is what arrived and never changes; `remaining` is what is still on
-- the shelf. Buying the same add-on twice at two rates makes two batches, so the
-- unit handed to a customer always reports what it actually cost.
--
-- addon_id is ON DELETE SET NULL and name/code are snapshotted, so purchase
-- history outlives the catalogue row — the same treatment stock_items gets.
CREATE TABLE IF NOT EXISTS public.addon_stock_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addon_id      UUID REFERENCES public.addons(id) ON DELETE SET NULL,
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The supplier run this lot arrived on. Shared with machinery stock-in: one
  -- order, one receipt photo, machines and add-ons on it. SET NULL, not CASCADE
  -- — deleting an order must never delete the stock it brought in.
  order_id      UUID REFERENCES public.stock_orders(id) ON DELETE SET NULL,
  addon_name    TEXT,
  addon_code    TEXT,
  -- `<CODE>-B0001`, filled in by the trigger below. The ledger's reference
  -- column for an add-on purchase row.
  batch_code    TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  remaining     INTEGER NOT NULL CHECK (remaining >= 0),
  unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT addon_batch_remaining_within_quantity CHECK (remaining <= quantity)
);

-- "next batch to draw from for this add-on", FIFO by created_at.
CREATE INDEX IF NOT EXISTS addon_batches_fifo_idx
  ON public.addon_stock_batches (addon_id, created_at) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS addon_batches_org_created_idx
  ON public.addon_stock_batches (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS addon_batches_order_idx
  ON public.addon_stock_batches (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS addon_batches_code_idx
  ON public.addon_stock_batches (addon_id, batch_code);

ALTER TABLE public.addon_stock_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.addon_stock_batches FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addon_stock_batches TO authenticated;
GRANT ALL ON public.addon_stock_batches TO service_role;

DROP POLICY IF EXISTS "Members can view org addon batches"  ON public.addon_stock_batches;
DROP POLICY IF EXISTS "Admins can insert org addon batches" ON public.addon_stock_batches;
DROP POLICY IF EXISTS "Admins can update org addon batches" ON public.addon_stock_batches;
DROP POLICY IF EXISTS "Admins can delete org addon batches" ON public.addon_stock_batches;

-- Members read (they need to know how many are left before promising one).
-- Only admins receive, correct or delete stock — the "employees cannot add
-- stock" rule, applied to add-ons. Note that UPDATE stays admin-only here,
-- unlike stock_items: selling does not update this table directly, it goes
-- through addon_attach_to_sale(), which is SECURITY DEFINER.
CREATE POLICY "Members can view org addon batches"
  ON public.addon_stock_batches FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can insert org addon batches"
  ON public.addon_stock_batches FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can update org addon batches"
  ON public.addon_stock_batches FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can delete org addon batches"
  ON public.addon_stock_batches FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));


-- Batch codes are issued per add-on: TK-01-B0001, TK-01-B0002, … The addon row
-- is locked first, so two admins stocking in the same add-on at the same moment
-- queue up instead of both claiming -B0003. Snapshots are filled in here too, so
-- no caller can forget them.
CREATE OR REPLACE FUNCTION public.addon_batch_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name   TEXT;
  v_code   TEXT;
  v_prefix TEXT;
  v_seq    INTEGER;
BEGIN
  IF NEW.remaining IS NULL THEN
    NEW.remaining := NEW.quantity;
  END IF;

  SELECT name, code INTO v_name, v_code
  FROM public.addons WHERE id = NEW.addon_id FOR UPDATE;

  NEW.addon_name := COALESCE(NEW.addon_name, v_name);
  NEW.addon_code := COALESCE(NEW.addon_code, v_code);

  IF NEW.batch_code IS NULL OR NEW.batch_code = '' THEN
    v_prefix := COALESCE(NULLIF(regexp_replace(upper(COALESCE(v_code, '')), '[^A-Z0-9]+', '-', 'g'), ''), 'ADDON');
    -- Continue from the HIGHEST number already issued under this prefix, not
    -- from a row count. Counting breaks the moment a batch is deleted: three
    -- batches minus one gives a count of 2, the next insert claims -B0003, and
    -- the unique index rejects it. Same rule the machinery side uses for
    -- manufacture ids (nextManufactureIds in inventory.functions.ts).
    SELECT COALESCE(MAX(substring(batch_code FROM '[0-9]+$')::INTEGER), 0) + 1
      INTO v_seq
    FROM public.addon_stock_batches
    WHERE addon_id = NEW.addon_id
      AND batch_code ~ ('^' || v_prefix || '-B[0-9]+$');
    NEW.batch_code := v_prefix || '-B' || lpad(v_seq::TEXT, 4, '0');
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.addon_batch_defaults() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS addon_batches_defaults ON public.addon_stock_batches;
CREATE TRIGGER addon_batches_defaults
  BEFORE INSERT ON public.addon_stock_batches
  FOR EACH ROW EXECUTE FUNCTION public.addon_batch_defaults();


-- ---------------------------------------------------------------------------
-- 3. sale_addons — what actually went out of the door with a sale
-- ---------------------------------------------------------------------------
-- sales holds one row per unit sold, so a sale_addons row reads as "this unit
-- went out with N of these". sale_id is NOT NULL with ON DELETE CASCADE: an
-- add-on line cannot exist without a sale, which is rule 3 expressed as a
-- foreign key rather than as a check in application code.
--
-- Nothing here touches what the customer pays. total_cost is what the giveaway
-- cost the organization, and it is subtracted from the sale's profit.
CREATE TABLE IF NOT EXISTS public.sale_addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         UUID NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  addon_id        UUID REFERENCES public.addons(id) ON DELETE SET NULL,
  batch_id        UUID REFERENCES public.addon_stock_batches(id) ON DELETE SET NULL,
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  addon_name      TEXT,
  addon_code      TEXT,
  addon_image_url TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  -- copied off the batch at attach time, so a later price correction on the
  -- catalogue never rewrites the profit of a sale that already happened.
  unit_cost       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total_cost      NUMERIC(12,2) GENERATED ALWAYS AS (unit_cost * quantity) STORED,
  list_value      NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_addons_sale_idx  ON public.sale_addons (sale_id);
CREATE INDEX IF NOT EXISTS sale_addons_org_idx   ON public.sale_addons (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sale_addons_addon_idx ON public.sale_addons (addon_id);
CREATE INDEX IF NOT EXISTS sale_addons_batch_idx ON public.sale_addons (batch_id);

ALTER TABLE public.sale_addons ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sale_addons FROM PUBLIC, anon;
-- Deliberately NO INSERT and NO UPDATE grant for `authenticated`: add-on stock
-- can only be consumed through addon_attach_to_sale(), which requires a sale.
GRANT SELECT, DELETE ON public.sale_addons TO authenticated;
GRANT ALL ON public.sale_addons TO service_role;

DROP POLICY IF EXISTS "Members can view org sale addons" ON public.sale_addons;
DROP POLICY IF EXISTS "Admins can delete org sale addons" ON public.sale_addons;

CREATE POLICY "Members can view org sale addons"
  ON public.sale_addons FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

-- Taking an add-on back off a sale is a correction, so it is admin-only. The
-- trigger below returns the units to their batch.
CREATE POLICY "Admins can delete org sale addons"
  ON public.sale_addons FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));


-- Removing an add-on line puts the units back on the shelf. This also covers
-- deleting the whole sale, which cascades to these rows — an erased sale should
-- not silently eat the add-on stock it consumed. Clamped at the batch's original
-- quantity so a double restore can never inflate stock.
CREATE OR REPLACE FUNCTION public.addon_restore_batch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.batch_id IS NOT NULL THEN
    UPDATE public.addon_stock_batches
       SET remaining = LEAST(quantity, remaining + OLD.quantity)
     WHERE id = OLD.batch_id;
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.addon_restore_batch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sale_addons_restore_batch ON public.sale_addons;
CREATE TRIGGER sale_addons_restore_batch
  AFTER DELETE ON public.sale_addons
  FOR EACH ROW EXECUTE FUNCTION public.addon_restore_batch();


-- ---------------------------------------------------------------------------
-- 4. stock_orders gains its add-on totals
-- ---------------------------------------------------------------------------
-- One supplier run can carry machines and add-ons under one receipt. The two
-- spends are kept apart so the Purchases page can still answer "what did we
-- spend on machinery" without add-ons quietly inflating the number.
-- total_cost / unit_count keep their existing machinery-only meaning.
ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS addon_unit_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addon_cost       NUMERIC NOT NULL DEFAULT 0;


-- ---------------------------------------------------------------------------
-- 5. addon_attach_to_sale() — the only door into add-on stock
-- ---------------------------------------------------------------------------
-- Consumes `p_qty` units of an add-on, oldest batch first, and writes one
-- sale_addons row per batch it draws from. Returns what the giveaway cost, which
-- is the amount that comes off the sale's profit.
--
-- SECURITY DEFINER because it writes sale_addons, which `authenticated` cannot
-- insert into directly. Everything it trusts is re-derived from the caller's
-- JWT, so nothing can be forged by passing a different id:
--   * the org comes from current_org_id(), never from an argument;
--   * the sale must already exist IN THAT ORG — this is what makes "an add-on
--     cannot be sold without an item" true at the database level;
--   * the add-on must belong to that org too.
--
-- Any member can call it: giving an add-on away is part of ringing up a sale.
-- If stock runs out mid-loop the function raises, and because a function body
-- is atomic the partial consumption is rolled back — you never end up with two
-- of the three units gone and no record of the third.
CREATE OR REPLACE FUNCTION public.addon_attach_to_sale(
  p_sale_id  UUID,
  p_addon_id UUID,
  p_qty      INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org   UUID;
  v_name  TEXT;
  v_code  TEXT;
  v_img   TEXT;
  v_value NUMERIC;
  v_left  INTEGER := p_qty;
  v_take  INTEGER;
  v_cost  NUMERIC := 0;
  b       RECORD;
BEGIN
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 1000 THEN
    RAISE EXCEPTION 'Add-on quantity must be between 1 and 1000';
  END IF;

  v_org := public.current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Not a member of any organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sales WHERE id = p_sale_id AND org_id = v_org
  ) THEN
    RAISE EXCEPTION 'An add-on can only go out with a sale in your organization';
  END IF;

  SELECT name, code, image_url, list_value
    INTO v_name, v_code, v_img, v_value
  FROM public.addons
  WHERE id = p_addon_id AND org_id = v_org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Add-on not found in your organization';
  END IF;

  -- FIFO. FOR UPDATE holds each batch row for the rest of the transaction, so
  -- two tills selling the last case cannot both take it.
  FOR b IN
    SELECT id, remaining, unit_cost
    FROM public.addon_stock_batches
    WHERE addon_id = p_addon_id AND org_id = v_org AND remaining > 0
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, b.remaining);

    UPDATE public.addon_stock_batches
       SET remaining = remaining - v_take
     WHERE id = b.id;

    INSERT INTO public.sale_addons (
      sale_id, addon_id, batch_id, org_id, user_id,
      addon_name, addon_code, addon_image_url,
      quantity, unit_cost, list_value
    ) VALUES (
      p_sale_id, p_addon_id, b.id, v_org, (select auth.uid()),
      v_name, v_code, v_img,
      v_take, b.unit_cost, COALESCE(v_value, 0)
    );

    v_cost := v_cost + (v_take * b.unit_cost);
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    RAISE EXCEPTION 'Only % unit(s) of "%" left in stock — % requested',
      p_qty - v_left, v_name, p_qty;
  END IF;

  RETURN v_cost;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.addon_attach_to_sale(UUID, UUID, INTEGER) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.addon_attach_to_sale(UUID, UUID, INTEGER) TO authenticated;


-- Checkout attaches add-ons to many sale rows at once. Doing that as N RPCs
-- would be N round trips and N chances to half-fail; this takes the whole lot in
-- one call, inside one transaction — every add-on on the cart lands, or none do.
--
-- p_lines is a JSON array: [{"sale_id": "...", "addon_id": "...", "qty": 2}, …]
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
    v_total := v_total + public.addon_attach_to_sale(
      (v_line->>'sale_id')::UUID,
      (v_line->>'addon_id')::UUID,
      (v_line->>'qty')::INTEGER
    );
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.addon_attach_bulk(JSONB) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.addon_attach_bulk(JSONB) TO authenticated;


-- ---------------------------------------------------------------------------
-- 6. Views — on-hand stock, and add-on cost per sale
-- ---------------------------------------------------------------------------
-- security_invoker: the views run with the CALLER's privileges, so the RLS on
-- addons / addon_stock_batches / sale_addons applies through them. Without it a
-- view would be a hole straight past the tenant boundary.

-- What is on the shelf, per add-on. Derived, so it cannot drift the way a
-- denormalized counter can. `on_hand` is what the sell-time picker reads.
CREATE OR REPLACE VIEW public.addon_stock_levels
WITH (security_invoker = on) AS
SELECT
  a.id      AS addon_id,
  a.org_id,
  COALESCE(SUM(b.remaining), 0)::INTEGER              AS on_hand,
  COALESCE(SUM(b.quantity), 0)::INTEGER               AS received,
  COALESCE(SUM(b.quantity - b.remaining), 0)::INTEGER AS given_away,
  COALESCE(SUM(b.remaining * b.unit_cost), 0)         AS on_hand_value,
  COALESCE(SUM(b.quantity  * b.unit_cost), 0)         AS total_spend
FROM public.addons a
LEFT JOIN public.addon_stock_batches b ON b.addon_id = a.id
GROUP BY a.id, a.org_id;

-- One row per sale that had add-ons on it. Join this into the ledger, the sale
-- detail drawer and the profit series: profit = selling_price - unit cost -
-- addon_cost.
CREATE OR REPLACE VIEW public.sale_addon_totals
WITH (security_invoker = on) AS
SELECT
  sa.sale_id,
  sa.org_id,
  SUM(sa.quantity)::INTEGER          AS addon_units,
  SUM(sa.total_cost)                 AS addon_cost,
  SUM(sa.list_value * sa.quantity)   AS addon_list_value
FROM public.sale_addons sa
GROUP BY sa.sale_id, sa.org_id;

REVOKE ALL ON public.addon_stock_levels FROM PUBLIC, anon;
REVOKE ALL ON public.sale_addon_totals  FROM PUBLIC, anon;
GRANT SELECT ON public.addon_stock_levels TO authenticated;
GRANT SELECT ON public.sale_addon_totals  TO authenticated;
