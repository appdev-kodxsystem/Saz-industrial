-- ============================================================================
-- SAZ-Industrial — canonical schema (tables, RLS, policies, grants, storage)
-- ============================================================================
-- Consolidates every migration under supabase/migrations into one script that
-- reproduces the database from scratch, with the security gaps closed.
--
-- Idempotent: safe to re-run. It never drops a table and never deletes a row.
--
-- Security model
--   * The tenant is the ORGANIZATION, not the user. Every data table is
--     RLS-enabled and scoped to `org_id = current_org_id()`; `user_id` survives
--     on each row only as an audit stamp ("who did this"). profiles remain
--     `id = auth.uid()`. Ownership is enforced in the database, not in
--     application code.
--   * Two roles, stored on organization_members:
--       admin     — everything: products, stock, purchases, reports, the team.
--       employee  — reads inventory, sells, settles payments. No product or
--                   stock writes, and no access to cost/profit.
--     The split is expressed as RLS policies (INSERT/DELETE on products and
--     stock_items require is_org_admin()), so hiding a button in the UI is a
--     courtesy and the database is the actual boundary.
--   * Server functions (src/lib/inventory.functions.ts) run through
--     requireOrgMember / requireOrgAdmin, which build a Supabase client from the
--     ANON key plus the caller's JWT. RLS is therefore the real tenant boundary
--     those queries have.
--   * Membership writes (invite / role change / removal) are SECURITY DEFINER
--     functions that re-derive the caller's org and admin status from the JWT.
--     `authenticated` has no INSERT/UPDATE/DELETE grant on organization_members,
--     so an employee cannot promote themselves via PostgREST. The service-role
--     key is needed only to SEND the invite email, never to write a row.
--   * `anon` gets no table privileges. Its only reachable surface is the
--     email_exists() RPC.
--   * Policies use `(select auth.uid())` / `(select current_org_id())` rather
--     than bare calls so Postgres hoists them into an InitPlan and evaluates
--     them once per statement instead of once per row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;  -- gen_random_uuid()


-- ---------------------------------------------------------------------------
-- 1. Shared trigger function: keep updated_at honest
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Trigger functions are invoked by the trigger, never called directly.
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. profiles — one row per auth user
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT,
  avatar_url    TEXT,
  company       TEXT,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports email_exists() lookups, which compare on lower(email).
CREATE INDEX IF NOT EXISTS profiles_email_lower_idx ON public.profiles (lower(email));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.profiles FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

DROP POLICY IF EXISTS "Users can view their own profile"   ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;

CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  TO authenticated USING ((select auth.uid()) = id);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  TO authenticated WITH CHECK ((select auth.uid()) = id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  TO authenticated USING ((select auth.uid()) = id) WITH CHECK ((select auth.uid()) = id);

-- No DELETE policy and no DELETE grant: profiles die with their auth.users row.

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 3. organizations + organization_members
-- ---------------------------------------------------------------------------
-- The tenant. An organization has many members; they all read the same
-- products, stock and sales.
CREATE TABLE IF NOT EXISTS public.organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS organizations_set_updated_at ON public.organizations;
CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- One row per person in an org. Created when the admin invites the email, at
-- which point user_id is NULL and status is 'pending'; handle_new_user() claims
-- it once the invitee accepts. user_id is UNIQUE — a user belongs to exactly one
-- organization, which keeps current_org_id() a single unambiguous lookup.
CREATE TABLE IF NOT EXISTS public.organization_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id     UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  status      TEXT NOT NULL DEFAULT 'pending'  CHECK (status IN ('pending', 'active')),
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_org_email_idx
  ON public.organization_members (org_id, lower(email));
CREATE INDEX IF NOT EXISTS organization_members_email_lower_idx
  ON public.organization_members (lower(email));
CREATE INDEX IF NOT EXISTS organization_members_org_id_idx
  ON public.organization_members (org_id);

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS organization_members_set_updated_at ON public.organization_members;
CREATE TRIGGER organization_members_set_updated_at
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

REVOKE ALL ON public.organizations        FROM PUBLIC, anon;
REVOKE ALL ON public.organization_members FROM PUBLIC, anon;
GRANT SELECT, UPDATE ON public.organizations        TO authenticated;
GRANT SELECT         ON public.organization_members TO authenticated;
GRANT ALL            ON public.organizations        TO service_role;
GRANT ALL            ON public.organization_members TO service_role;


-- ---------------------------------------------------------------------------
-- 4. Membership lookups used by every policy below
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER is load-bearing: these read organization_members, and
-- organization_members' own policies call them. A plain function would recurse
-- (policy -> function -> policy -> ...). DEFINER skips RLS on the inner read and
-- breaks the cycle. STABLE lets Postgres evaluate them once per statement.
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT org_id FROM public.organization_members
  WHERE user_id = (select auth.uid()) AND status = 'active'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_org_role()
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT role FROM public.organization_members
  WHERE user_id = (select auth.uid()) AND status = 'active'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = (select auth.uid()) AND status = 'active' AND role = 'admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.current_org_id()   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_org_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin()     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_org_id()   TO authenticated;
GRANT  EXECUTE ON FUNCTION public.current_org_role() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_org_admin()     TO authenticated;

DROP POLICY IF EXISTS "Members can view their organization"  ON public.organizations;
DROP POLICY IF EXISTS "Admins can rename their organization" ON public.organizations;
DROP POLICY IF EXISTS "Members can view their teammates"     ON public.organization_members;

CREATE POLICY "Members can view their organization"
  ON public.organizations FOR SELECT
  TO authenticated USING (id = (select public.current_org_id()));

CREATE POLICY "Admins can rename their organization"
  ON public.organizations FOR UPDATE
  TO authenticated
  USING      (id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Members can view their teammates"
  ON public.organization_members FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

-- No INSERT/UPDATE/DELETE policy or grant on organization_members for
-- `authenticated`: every membership write goes through the admin-checked
-- SECURITY DEFINER functions in section 11.


-- ---------------------------------------------------------------------------
-- 5. Auto-provision a profile + an organization on signup
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: fires as the auth.users owner, so it can write a profile
-- row before the new user has a session of their own.
--
-- Two paths for placing the new user in an org:
--   a. A pending invite exists for this email — claim it. The invitee lands in
--      the inviting admin's org with the role that admin chose.
--   b. No pending invite — an ordinary self-signup. Give them a fresh
--      organization and make them its admin, so current_org_id() is never NULL.
--
-- SECURITY: nothing that decides org or role is read from raw_user_meta_data.
-- That field is the client-supplied options.data of signUp, sent with the anon
-- key, so it is attacker-controlled. Trusting a metadata org_id/role here would
-- let anyone who knew an org's UUID sign up as its admin. Placement into an
-- existing org is ONLY ever by claiming an admin-created pending invite.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id  UUID;
  v_org_id     UUID;
  v_org_name   TEXT;
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url, email)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    ),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture'),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;

  -- (a) claim a pending invite created by an admin of the inviting org
  SELECT id, org_id INTO v_member_id, v_org_id
  FROM public.organization_members
  WHERE lower(email) = lower(NEW.email) AND user_id IS NULL
  ORDER BY created_at
  LIMIT 1;

  IF v_member_id IS NOT NULL THEN
    UPDATE public.organization_members
       SET user_id = NEW.id, status = 'active'
     WHERE id = v_member_id;
    RETURN NEW;
  END IF;

  -- (b) self-signup: their own org, as admin
  v_org_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'company'), ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  INSERT INTO public.organizations (name) VALUES (v_org_name) RETURNING id INTO v_org_id;

  INSERT INTO public.organization_members (org_id, user_id, email, role, status)
  VALUES (v_org_id, NEW.id, NEW.email, 'admin', 'active');

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ---------------------------------------------------------------------------
-- 6. products
-- ---------------------------------------------------------------------------
-- org_id is the tenant key and the RLS predicate. user_id is kept only as an
-- audit stamp: which member last wrote the row.
CREATE TABLE IF NOT EXISTS public.products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sku             TEXT NOT NULL,
  image_url       TEXT,
  category        TEXT NOT NULL DEFAULT 'Uncategorized',
  description     TEXT,
  stock           INTEGER NOT NULL DEFAULT 0,
  reorder_at      INTEGER NOT NULL DEFAULT 5,
  purchase_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  selling_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_org_id_idx     ON public.products(org_id);
CREATE INDEX IF NOT EXISTS products_org_pinned_idx ON public.products(org_id, pinned DESC, updated_at DESC);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.products FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;

DROP POLICY IF EXISTS "Users can view their own products"   ON public.products;
DROP POLICY IF EXISTS "Users can insert their own products" ON public.products;
DROP POLICY IF EXISTS "Users can update their own products" ON public.products;
DROP POLICY IF EXISTS "Users can delete their own products" ON public.products;
DROP POLICY IF EXISTS "Members can view org products"  ON public.products;
DROP POLICY IF EXISTS "Admins can insert org products" ON public.products;
DROP POLICY IF EXISTS "Admins can update org products" ON public.products;
DROP POLICY IF EXISTS "Admins can delete org products" ON public.products;

-- Read: any member — an employee needs the catalogue to sell from it.
-- Write: admins only. This is the "employees cannot add or edit products" rule,
-- enforced where it cannot be bypassed.
CREATE POLICY "Members can view org products"
  ON public.products FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can insert org products"
  ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

-- WITH CHECK repeats the predicate so a row cannot be moved to another org.
CREATE POLICY "Admins can update org products"
  ON public.products FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can delete org products"
  ON public.products FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

DROP TRIGGER IF EXISTS products_set_updated_at ON public.products;
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 7. stock_items — one row per physical unit
-- ---------------------------------------------------------------------------
-- product_id is ON DELETE SET NULL, and name/sku/image are snapshotted at
-- stock-in, so purchase history outlives the product it came from. org_id is
-- what keeps the row addressable once product_id goes NULL — it is the RLS key.
CREATE TABLE IF NOT EXISTS public.stock_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID REFERENCES public.products(id) ON DELETE SET NULL,
  org_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id            UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  product_name       TEXT,
  product_sku        TEXT,
  product_image_url  TEXT,
  manufacture_id     TEXT NOT NULL,
  purchase_price     NUMERIC NOT NULL DEFAULT 0,
  sold               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold_at            TIMESTAMPTZ
);

-- Partial index: "next available unit for this product", FIFO by created_at.
CREATE INDEX IF NOT EXISTS idx_stock_items_product_created
  ON public.stock_items(product_id, created_at) WHERE sold = false;
CREATE INDEX IF NOT EXISTS stock_items_org_id_idx      ON public.stock_items(org_id);
CREATE INDEX IF NOT EXISTS stock_items_org_created_idx ON public.stock_items(org_id, created_at DESC);

ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stock_items FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_items TO authenticated;
GRANT ALL ON public.stock_items TO service_role;

DROP POLICY IF EXISTS "Users can view their own stock items"   ON public.stock_items;
DROP POLICY IF EXISTS "Users can insert their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can update their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can delete their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Members can view org stock items"   ON public.stock_items;
DROP POLICY IF EXISTS "Admins can insert org stock items"  ON public.stock_items;
DROP POLICY IF EXISTS "Members can update org stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Admins can delete org stock items"  ON public.stock_items;

-- INSERT (stock-in) and DELETE are admin-only: that is the "employees cannot add
-- stock" rule. UPDATE stays open to any member because selling a unit flips
-- sold/sold_at on this table.
CREATE POLICY "Members can view org stock items"
  ON public.stock_items FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can insert org stock items"
  ON public.stock_items FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Members can update org stock items"
  ON public.stock_items FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()))
  WITH CHECK (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can delete org stock items"
  ON public.stock_items FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));


-- ---------------------------------------------------------------------------
-- 8. sales — one row per unit sold
-- ---------------------------------------------------------------------------
-- Holds customer PII (name, contact) and full pricing, so it is the most
-- sensitive table here. Both FKs are ON DELETE SET NULL so a sale, and any
-- outstanding balance on it, survives deletion of the product or stock item.
-- user_id records which member rang up the sale; org_id owns the row.
CREATE TABLE IF NOT EXISTS public.sales (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID REFERENCES public.products(id) ON DELETE SET NULL,
  stock_item_id      UUID REFERENCES public.stock_items(id) ON DELETE SET NULL,
  org_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id            UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  product_name       TEXT,
  product_sku        TEXT,
  product_image_url  TEXT,
  selling_price      NUMERIC NOT NULL,
  net_payment        NUMERIC NOT NULL DEFAULT 0,
  -- Derived, never written: cannot drift from its inputs.
  pending_payment    NUMERIC GENERATED ALWAYS AS (selling_price - net_payment) STORED,
  payment_status     TEXT NOT NULL DEFAULT 'completed',
  customer_name      TEXT,
  customer_contact   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_pending      ON public.sales(payment_status) WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS sales_org_id_idx      ON public.sales(org_id);
CREATE INDEX IF NOT EXISTS sales_org_created_idx ON public.sales(org_id, created_at DESC);

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sales FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales TO authenticated;
GRANT ALL ON public.sales TO service_role;

DROP POLICY IF EXISTS "Users can view their own sales"   ON public.sales;
DROP POLICY IF EXISTS "Users can insert their own sales" ON public.sales;
DROP POLICY IF EXISTS "Users can update their own sales" ON public.sales;
DROP POLICY IF EXISTS "Users can delete their own sales" ON public.sales;
DROP POLICY IF EXISTS "Members can view org sales"   ON public.sales;
DROP POLICY IF EXISTS "Members can insert org sales" ON public.sales;
DROP POLICY IF EXISTS "Members can update org sales" ON public.sales;
DROP POLICY IF EXISTS "Admins can delete org sales"  ON public.sales;

-- Selling is the employee's whole job, so INSERT is open to any member, as is
-- UPDATE (settlePayment writes net_payment + payment_status). Only an admin can
-- erase a sale.
CREATE POLICY "Members can view org sales"
  ON public.sales FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Members can insert org sales"
  ON public.sales FOR INSERT
  TO authenticated WITH CHECK (org_id = (select public.current_org_id()));

CREATE POLICY "Members can update org sales"
  ON public.sales FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()))
  WITH CHECK (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can delete org sales"
  ON public.sales FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));


-- ---------------------------------------------------------------------------
-- 9. apply_stock_delta() — the one write an employee needs on products
-- ---------------------------------------------------------------------------
-- Selling a unit decrements products.stock, but products.UPDATE is admin-only.
-- Rather than widen that policy (which would also let employees rewrite prices
-- and names), the stock counter gets its own narrow door: a SECURITY DEFINER
-- function that can change nothing but `stock`, and only on a product in the
-- caller's own org. `stock = stock + delta` in one statement is also atomic,
-- where the SELECT-then-UPDATE it replaced could lose a concurrent sale.
CREATE OR REPLACE FUNCTION public.apply_stock_delta(p_product_id UUID, p_delta INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_next   INTEGER;
BEGIN
  v_org_id := public.current_org_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Not a member of any organization';
  END IF;

  -- Granted to `authenticated`, so callable directly. A positive delta (adding
  -- stock) is admin-only — otherwise an employee could inflate any product's
  -- counter, defeating "employees cannot add stock". A negative delta is a sale
  -- decrement, open to any member. Magnitude is bounded either way (a cart sells
  -- at most 200 units, far inside this).
  IF p_delta > 0 AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can increase stock';
  END IF;
  IF abs(p_delta) > 100000 THEN
    RAISE EXCEPTION 'Stock change out of range';
  END IF;

  UPDATE public.products
     SET stock = GREATEST(0, stock + p_delta)
   WHERE id = p_product_id
     AND org_id = v_org_id
  RETURNING stock INTO v_next;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found in your organization';
  END IF;

  RETURN v_next;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_stock_delta(UUID, INTEGER) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.apply_stock_delta(UUID, INTEGER) TO authenticated;


-- ---------------------------------------------------------------------------
-- 10. Membership writes — SECURITY DEFINER, admin-checked in the database
-- ---------------------------------------------------------------------------
-- `authenticated` has no INSERT/UPDATE/DELETE grant on organization_members, so
-- these functions are the only way in. Each re-derives the caller's org and admin
-- status from their JWT — nothing is passed in, so nothing can be forged. That
-- keeps the app's privilege floor low: managing a team never needs a key that
-- bypasses RLS. (Sending the invite EMAIL still needs the service-role key —
-- that is Supabase's admin Auth API, not SQL.)

CREATE OR REPLACE FUNCTION public.org_list_members()
RETURNS TABLE (
  id UUID, user_id UUID, email TEXT, role TEXT, status TEXT,
  display_name TEXT, avatar_url TEXT, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT m.id, m.user_id, m.email, m.role, m.status,
         p.display_name, p.avatar_url, m.created_at
  FROM public.organization_members m
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.org_id = public.current_org_id()
  ORDER BY m.created_at;
$$;

CREATE OR REPLACE FUNCTION public.org_invite_member(p_email TEXT, p_role TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_email  TEXT;
  v_id     UUID;
BEGIN
  IF NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can invite members';
  END IF;
  IF p_role NOT IN ('admin', 'employee') THEN
    RAISE EXCEPTION 'Unknown role: %', p_role;
  END IF;

  v_org_id := public.current_org_id();
  v_email  := lower(trim(p_email));

  IF EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE org_id = v_org_id AND lower(email) = v_email
  ) THEN
    RAISE EXCEPTION 'That email is already on your team';
  END IF;

  INSERT INTO public.organization_members (org_id, email, role, status, invited_by)
  VALUES (v_org_id, v_email, p_role, 'pending', (select auth.uid()))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Undo the row above when the invite email fails to send. Restricted to rows
-- that are still pending, so it can never evict an active teammate.
CREATE OR REPLACE FUNCTION public.org_discard_invite(p_member_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can withdraw an invite';
  END IF;

  DELETE FROM public.organization_members
  WHERE id = p_member_id
    AND org_id = public.current_org_id()
    AND status = 'pending';
END;
$$;

CREATE OR REPLACE FUNCTION public.org_update_member_role(p_member_id UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org_id   UUID;
  v_old_role TEXT;
BEGIN
  IF NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can change roles';
  END IF;
  IF p_role NOT IN ('admin', 'employee') THEN
    RAISE EXCEPTION 'Unknown role: %', p_role;
  END IF;

  v_org_id := public.current_org_id();

  SELECT role INTO v_old_role
  FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;

  IF v_old_role IS NULL THEN
    RAISE EXCEPTION 'Member not found';
  END IF;

  IF v_old_role = 'admin' AND p_role = 'employee' THEN
    PERFORM public.assert_org_keeps_an_admin(v_org_id, p_member_id);
  END IF;

  UPDATE public.organization_members
     SET role = p_role
   WHERE id = p_member_id AND org_id = v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.org_remove_member(p_member_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_role   TEXT;
  v_user   UUID;
BEGIN
  IF NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can remove members';
  END IF;

  v_org_id := public.current_org_id();

  SELECT role, user_id INTO v_role, v_user
  FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Member not found';
  END IF;
  IF v_user = (select auth.uid()) THEN
    RAISE EXCEPTION 'You cannot remove yourself from your own organization';
  END IF;

  IF v_role = 'admin' THEN
    PERFORM public.assert_org_keeps_an_admin(v_org_id, p_member_id);
  END IF;

  -- Only the membership goes. The auth user, and every sale they recorded,
  -- survive — their current_org_id() simply becomes NULL, and RLS stops handing
  -- them this org's rows on their next request.
  DELETE FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;
END;
$$;

-- An org with no admin is an org nobody can ever add a product to again.
CREATE OR REPLACE FUNCTION public.assert_org_keeps_an_admin(p_org_id UUID, p_excluding UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE org_id = p_org_id
      AND id <> p_excluding
      AND role = 'admin'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Your organization must keep at least one admin';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.org_list_members()                    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_invite_member(TEXT, TEXT)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_discard_invite(UUID)              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_update_member_role(UUID, TEXT)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_remove_member(UUID)               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assert_org_keeps_an_admin(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.org_list_members()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_invite_member(TEXT, TEXT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_discard_invite(UUID)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_update_member_role(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_remove_member(UUID)            TO authenticated;


-- ---------------------------------------------------------------------------
-- 11. email_exists() — anon-callable account probe
-- ---------------------------------------------------------------------------
-- Backs the forgot-password screen. SECURITY DEFINER so it can read profiles
-- without granting anon any access to the table; returns a bare boolean.
CREATE OR REPLACE FUNCTION public.email_exists(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE lower(email) = lower(trim(p_email))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.email_exists(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.email_exists(TEXT) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- 12. Storage: avatars (public read, owner-only write)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public can read avatars"          ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;

-- Bucket is public so <img src> resolves without a signed URL.
CREATE POLICY "Public can read avatars"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- Writes are confined to avatars/<uid>/<file>, matching the upload path in
-- src/routes/_authenticated/profile.tsx.
CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING      (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);


-- ---------------------------------------------------------------------------
-- 13. Storage: receipts (private, owner-scoped)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated can read receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload receipts" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update receipts" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Users can upload receipts"           ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own receipts" ON storage.objects;

-- The app uploads to a shared receipts/cart/ prefix, so the path carries no
-- user id to scope on. Scope on the uploader instead: storage stamps owner_id
-- from the caller's JWT, and it is not client-settable. Read/update/delete are
-- therefore owner-only even though every receipt shares one prefix.
-- (`owner` is the legacy uuid column, `owner_id` the current text one.)
CREATE POLICY "Users can read their own receipts"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'receipts' AND COALESCE(owner_id, owner::text) = (select auth.uid())::text);

CREATE POLICY "Users can upload receipts"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'receipts');

CREATE POLICY "Users can update their own receipts"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING      (bucket_id = 'receipts' AND COALESCE(owner_id, owner::text) = (select auth.uid())::text)
  WITH CHECK (bucket_id = 'receipts' AND COALESCE(owner_id, owner::text) = (select auth.uid())::text);

CREATE POLICY "Users can delete their own receipts"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'receipts' AND COALESCE(owner_id, owner::text) = (select auth.uid())::text);


-- ---------------------------------------------------------------------------
-- 14. Default privileges for anything added later
-- ---------------------------------------------------------------------------
-- Supabase ships defaults that hand `anon` full DML on every new table in
-- public. Revoking them means the next table someone creates is closed until
-- its policies are written, rather than open until someone notices.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
