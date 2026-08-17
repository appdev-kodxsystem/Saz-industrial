-- ============================================================================
-- SAZ-Industrial — canonical schema (tables, RLS, policies, grants, storage)
-- ============================================================================
-- Consolidates every migration under supabase/migrations into one script that
-- reproduces the database from scratch, with the security gaps closed.
--
-- Idempotent: safe to re-run, on an empty database or a partially-migrated one.
-- It never drops a table and never deletes a row.
--
-- Every CREATE TABLE IF NOT EXISTS is followed by an ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS block listing the same columns. This is not redundancy: the
-- CREATE is skipped ENTIRELY when the table already exists, so without the ALTER
-- a database carrying an older version of a table sails past the CREATE and then
-- fails hundreds of lines later inside a function that selects a column it never
-- gained. The ALTERs omit NOT NULL, because a column added to a table that
-- already has rows cannot be NOT NULL without a default; fresh databases still
-- get the stricter definition from the CREATE.
--
-- Run this file, NOT the individual files under supabase/migrations. Each
-- migration assumes every earlier one has already been applied, so running a
-- late one on its own fails on a missing dependency.
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

-- Column reconciliation.
--
-- CREATE TABLE IF NOT EXISTS skips the WHOLE statement when the table already
-- exists — it does not add columns the table is missing. A database carrying an
-- older `profiles` therefore sails past the CREATE above and then fails several
-- hundred lines later inside org_list_members with "column p.display_name does
-- not exist". Every table in this file gets a block like this one so the script
-- is idempotent in the way it claims to be: safe on an empty database, and
-- safe on a partially-migrated one.
--
-- NOT NULL is deliberately omitted here even where the CREATE above has it: a
-- column being added to a table that already has rows cannot be NOT NULL
-- without a default, and refusing to widen an existing table would defeat the
-- point. Fresh databases still get the stricter definition from the CREATE.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT,
  ADD COLUMN IF NOT EXISTS company      TEXT,
  ADD COLUMN IF NOT EXISTS email        TEXT,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- Supports email_exists() lookups, which compare on lower(email).
CREATE INDEX IF NOT EXISTS profiles_email_lower_idx ON public.profiles (lower(email));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
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
-- owner_id: the member who created the org. Permanently an admin — cannot be
-- demoted or removed, by anyone, including other admins. SET NULL rather than
-- CASCADE so an organization is never deleted as a side effect of deleting a
-- user (the owner can't be removed anyway; this is belt and braces).
CREATE TABLE IF NOT EXISTS public.organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  owner_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS owner_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

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
  -- false until the member has chosen their own password. Invites create the
  -- auth account up front, so `status` is 'active' before the invitee has done
  -- anything — this is the honest "invite still outstanding" signal, and the
  -- /_authenticated guard bounces anyone with it false to /reset-password.
  password_set BOOLEAN NOT NULL DEFAULT true,
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.organization_members
  ADD COLUMN IF NOT EXISTS org_id       UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id      UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS email        TEXT,
  ADD COLUMN IF NOT EXISTS role         TEXT NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS invited_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

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

-- No UPDATE grant on organizations: renaming goes through org_rename(), because
-- RLS has no column-level security and a blanket UPDATE would also have let an
-- admin PATCH `owner_id` onto themselves and seize the org.
REVOKE ALL ON public.organizations        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organization_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organizations        TO authenticated;
GRANT SELECT ON public.organization_members TO authenticated;
GRANT ALL    ON public.organizations        TO service_role;
GRANT ALL    ON public.organization_members TO service_role;


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

  -- (b) self-signup: their own org, as its admin AND its owner
  v_org_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'company'), ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  INSERT INTO public.organizations (name, owner_id)
  VALUES (v_org_name, NEW.id)
  RETURNING id INTO v_org_id;

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
-- user_id is ON DELETE SET NULL, not CASCADE: removing a member deletes their
-- account, and the organization's catalogue must not go with them.
CREATE TABLE IF NOT EXISTS public.products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS org_id         UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS name           TEXT,
  ADD COLUMN IF NOT EXISTS sku            TEXT,
  ADD COLUMN IF NOT EXISTS image_url      TEXT,
  ADD COLUMN IF NOT EXISTS category       TEXT NOT NULL DEFAULT 'Uncategorized',
  ADD COLUMN IF NOT EXISTS description    TEXT,
  ADD COLUMN IF NOT EXISTS stock          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_at     INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selling_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pinned         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS products_org_id_idx     ON public.products(org_id);
CREATE INDEX IF NOT EXISTS products_org_pinned_idx ON public.products(org_id, pinned DESC, updated_at DESC);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.products FROM PUBLIC, anon, authenticated;
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
  user_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  product_name       TEXT,
  product_sku        TEXT,
  product_image_url  TEXT,
  manufacture_id     TEXT NOT NULL,
  purchase_price     NUMERIC NOT NULL DEFAULT 0,
  sold               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold_at            TIMESTAMPTZ
);

-- order_id is added further down, with stock_orders — it cannot be referenced
-- before that table exists.
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS product_id        UUID REFERENCES public.products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS org_id            UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_name      TEXT,
  ADD COLUMN IF NOT EXISTS product_sku       TEXT,
  ADD COLUMN IF NOT EXISTS product_image_url TEXT,
  ADD COLUMN IF NOT EXISTS manufacture_id    TEXT,
  ADD COLUMN IF NOT EXISTS purchase_price    NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sold              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sold_at           TIMESTAMPTZ;

-- Partial index: "next available unit for this product", FIFO by created_at.
CREATE INDEX IF NOT EXISTS idx_stock_items_product_created
  ON public.stock_items(product_id, created_at) WHERE sold = false;
CREATE INDEX IF NOT EXISTS stock_items_org_id_idx      ON public.stock_items(org_id);
CREATE INDEX IF NOT EXISTS stock_items_org_created_idx ON public.stock_items(org_id, created_at DESC);

ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stock_items FROM PUBLIC, anon, authenticated;
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
  -- SET NULL, not CASCADE: removing a member deletes their account, and a sale
  -- must outlive the person who rang it up.
  user_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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

-- pending_payment is a generated column, so it is derived on add rather than
-- backfilled — an older `sales` gains a correct balance for every existing row.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS product_id        UUID REFERENCES public.products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_item_id     UUID REFERENCES public.stock_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS org_id            UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_name      TEXT,
  ADD COLUMN IF NOT EXISTS product_sku       TEXT,
  ADD COLUMN IF NOT EXISTS product_image_url TEXT,
  ADD COLUMN IF NOT EXISTS selling_price     NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_payment       NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_payment   NUMERIC GENERATED ALWAYS AS (selling_price - net_payment) STORED,
  ADD COLUMN IF NOT EXISTS payment_status    TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS customer_name     TEXT,
  ADD COLUMN IF NOT EXISTS customer_contact  TEXT,
  ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_sales_pending      ON public.sales(payment_status) WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS sales_org_id_idx      ON public.sales(org_id);
CREATE INDEX IF NOT EXISTS sales_org_created_idx ON public.sales(org_id, created_at DESC);

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sales FROM PUBLIC, anon, authenticated;
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

DROP FUNCTION IF EXISTS public.org_list_members();

CREATE FUNCTION public.org_list_members()
RETURNS TABLE (
  id UUID, user_id UUID, email TEXT, role TEXT, status TEXT,
  display_name TEXT, avatar_url TEXT, password_set BOOLEAN,
  is_owner BOOLEAN, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT m.id, m.user_id, m.email, m.role, m.status,
         p.display_name, p.avatar_url, m.password_set,
         (m.user_id IS NOT NULL AND m.user_id = o.owner_id) AS is_owner,
         m.created_at
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.org_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.org_id = public.current_org_id()
  ORDER BY (m.user_id IS NOT NULL AND m.user_id = o.owner_id) DESC, m.created_at;
$$;

-- Is this membership row the organization's owner?
CREATE OR REPLACE FUNCTION public.is_org_owner_member(p_member_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.org_id
    WHERE m.id = p_member_id
      AND m.user_id IS NOT NULL
      AND m.user_id = o.owner_id
  );
$$;

-- Rename the org. Admins only, and it can touch nothing but `name` — which is
-- exactly why this exists instead of an UPDATE policy (RLS cannot restrict
-- columns, so a blanket UPDATE would have exposed owner_id).
CREATE OR REPLACE FUNCTION public.org_rename(p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can rename the organization';
  END IF;

  v_name := trim(p_name);
  IF v_name = '' OR v_name IS NULL THEN
    RAISE EXCEPTION 'Organization name cannot be empty';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION 'Organization name is too long';
  END IF;

  UPDATE public.organizations
     SET name = v_name
   WHERE id = public.current_org_id();
END;
$$;

-- The invitee closes the loop on themselves once they have actually chosen a
-- password. No arguments: the update is scoped to auth.uid(), so it can only
-- ever clear the flag for the caller.
CREATE OR REPLACE FUNCTION public.org_mark_password_set()
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.organization_members
     SET password_set = true
   WHERE user_id = (select auth.uid());
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

  -- password_set = false: they have no password yet, and the authenticated
  -- layout will hold them on /reset-password until they choose one.
  INSERT INTO public.organization_members (org_id, email, role, status, invited_by, password_set)
  VALUES (v_org_id, v_email, p_role, 'pending', (select auth.uid()), false)
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

  -- The owner is permanently an admin of the org they created.
  IF public.is_org_owner_member(p_member_id) THEN
    RAISE EXCEPTION 'The organization owner''s role cannot be changed';
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

-- Returns the removed member's auth user id so the server can then delete the
-- account through the admin Auth API (a membership-less account is useless and
-- would block re-inviting that email). NULL for a never-claimed invite.
DROP FUNCTION IF EXISTS public.org_remove_member(UUID);

CREATE FUNCTION public.org_remove_member(p_member_id UUID)
RETURNS UUID
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

  -- Nobody removes the owner — not another admin, not themselves.
  IF public.is_org_owner_member(p_member_id) THEN
    RAISE EXCEPTION 'The organization owner cannot be removed';
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

  -- The sales they recorded and the products they added survive: those FKs are
  -- ON DELETE SET NULL, so only the attribution goes. The account itself is then
  -- deleted by the caller (see removeMember in src/lib/org.functions.ts).
  DELETE FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;

  RETURN v_user;
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
REVOKE EXECUTE ON FUNCTION public.org_mark_password_set()               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_invite_member(TEXT, TEXT)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_discard_invite(UUID)              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_update_member_role(UUID, TEXT)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_remove_member(UUID)               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assert_org_keeps_an_admin(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_org_owner_member(UUID)             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.org_rename(TEXT)                      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_rename(TEXT)                      TO authenticated;

GRANT EXECUTE ON FUNCTION public.org_list_members()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_mark_password_set()            TO authenticated;
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
-- 14. Stock orders — one supplier run, many products, many units, one receipt
-- ---------------------------------------------------------------------------
-- Stock used to arrive one product at a time. This groups a whole purchase into
-- a single order row so the receipt photo, the supplier and the total have
-- somewhere to live, and every unit added in that run points back at it.
--
-- Non-destructive: stock_items.order_id is nullable, so every unit that predates
-- ordering stays valid with a NULL order.
CREATE TABLE IF NOT EXISTS public.stock_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- audit stamp only; goes NULL if the admin who placed the order is removed.
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  supplier     TEXT,
  note         TEXT,
  -- storage path inside the private `receipts` bucket, NOT a public URL. Read
  -- back through a signed URL — see signStorageUrl in the client.
  receipt_path TEXT,
  total_cost   NUMERIC NOT NULL DEFAULT 0,
  unit_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS org_id       UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supplier     TEXT,
  ADD COLUMN IF NOT EXISTS note         TEXT,
  ADD COLUMN IF NOT EXISTS receipt_path TEXT,
  ADD COLUMN IF NOT EXISTS total_cost   NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- ON DELETE SET NULL, not CASCADE: deleting an order must never delete the
-- stock units it brought in — they are inventory, and may already be sold.
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.stock_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stock_items_order_idx ON public.stock_items(order_id);
CREATE INDEX IF NOT EXISTS stock_orders_org_idx  ON public.stock_orders(org_id, created_at DESC);

-- Manufacture ids are generated server-side per product, and the generator picks
-- the next free number by reading the ids already on that product.
CREATE INDEX IF NOT EXISTS stock_items_product_mfr_idx
  ON public.stock_items(product_id, manufacture_id);

-- Same split as stock_items: any member reads, only admins write.
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

REVOKE ALL ON public.stock_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_orders TO authenticated;
GRANT ALL ON public.stock_orders TO service_role;


-- ---------------------------------------------------------------------------
-- 15. Add-ons — free extras handed out with a sold unit, paid for out of margin
-- ---------------------------------------------------------------------------
-- An add-on is something the org gives away with a machine (a spare blade, a
-- carry case, a warranty card). Three rules, all enforced here rather than in
-- the UI:
--   1. It never changes what the customer pays — nothing in `sales` moves.
--   2. What it cost the org comes off the PROFIT of the sale it went out on.
--   3. It cannot be sold on its own: sale_addons.sale_id is NOT NULL, and
--      `authenticated` has no INSERT grant on that table, so the only way to
--      consume add-on stock is addon_attach_to_sale(), which refuses to run
--      unless the sale already exists in the caller's org.
-- Every add-on concern is its own table — nothing is bolted onto products,
-- stock_items or sales.
--
-- Stock is tracked as BATCHES, not one row per unit like stock_items: add-ons
-- are bulk consumables with no serial number, and a batch still carries an exact
-- per-unit cost. On-hand is derived from the batches (addon_stock_levels), so
-- there is no counter to drift.

CREATE TABLE IF NOT EXISTS public.addons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'Uncategorized',
  description   TEXT,
  image_url     TEXT,
  -- default cost, used to seed stock-in. What actually hits profit is the
  -- unit_cost of the batch the unit came out of.
  unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  -- what it is worth to the customer, for the receipt line. Display only.
  list_value    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (list_value >= 0),
  reorder_at    INTEGER NOT NULL DEFAULT 5 CHECK (reorder_at >= 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.addons
  ADD COLUMN IF NOT EXISTS org_id      UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS name        TEXT,
  ADD COLUMN IF NOT EXISTS code        TEXT,
  ADD COLUMN IF NOT EXISTS category    TEXT NOT NULL DEFAULT 'Uncategorized',
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS image_url   TEXT,
  ADD COLUMN IF NOT EXISTS unit_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS list_value  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_at  INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS active      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS addons_org_code_idx   ON public.addons (org_id, lower(code));
CREATE INDEX        IF NOT EXISTS addons_org_active_idx ON public.addons (org_id, active, name);

ALTER TABLE public.addons ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.addons FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addons TO authenticated;
GRANT ALL ON public.addons TO service_role;

DROP POLICY IF EXISTS "Members can view org addons"  ON public.addons;
DROP POLICY IF EXISTS "Admins can insert org addons" ON public.addons;
DROP POLICY IF EXISTS "Admins can update org addons" ON public.addons;
DROP POLICY IF EXISTS "Admins can delete org addons" ON public.addons;

-- Same split as products: members read the catalogue, admins write it.
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


-- One row per lot received, at one price. `quantity` never changes; `remaining`
-- is what is still on the shelf. addon_id is SET NULL and name/code are
-- snapshotted, so purchase history outlives the catalogue row.
CREATE TABLE IF NOT EXISTS public.addon_stock_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addon_id      UUID REFERENCES public.addons(id) ON DELETE SET NULL,
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  order_id      UUID REFERENCES public.stock_orders(id) ON DELETE SET NULL,
  addon_name    TEXT,
  addon_code    TEXT,
  batch_code    TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  remaining     INTEGER NOT NULL CHECK (remaining >= 0),
  unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT addon_batch_remaining_within_quantity CHECK (remaining <= quantity)
);

ALTER TABLE public.addon_stock_batches
  ADD COLUMN IF NOT EXISTS addon_id   UUID REFERENCES public.addons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS org_id     UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS order_id   UUID REFERENCES public.stock_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS addon_name TEXT,
  ADD COLUMN IF NOT EXISTS addon_code TEXT,
  ADD COLUMN IF NOT EXISTS batch_code TEXT,
  ADD COLUMN IF NOT EXISTS quantity   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS addon_batches_fifo_idx
  ON public.addon_stock_batches (addon_id, created_at) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS addon_batches_org_created_idx
  ON public.addon_stock_batches (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS addon_batches_order_idx
  ON public.addon_stock_batches (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS addon_batches_code_idx
  ON public.addon_stock_batches (addon_id, batch_code);

ALTER TABLE public.addon_stock_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.addon_stock_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addon_stock_batches TO authenticated;
GRANT ALL ON public.addon_stock_batches TO service_role;

DROP POLICY IF EXISTS "Members can view org addon batches"  ON public.addon_stock_batches;
DROP POLICY IF EXISTS "Admins can insert org addon batches" ON public.addon_stock_batches;
DROP POLICY IF EXISTS "Admins can update org addon batches" ON public.addon_stock_batches;
DROP POLICY IF EXISTS "Admins can delete org addon batches" ON public.addon_stock_batches;

-- Members read (they need to know how many are left). Only admins receive or
-- correct stock. UPDATE stays admin-only, unlike stock_items: selling does not
-- write this table directly, addon_attach_to_sale() does.
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

-- Batch codes are issued per add-on (TK-01-B0001, -B0002, …). The addon row is
-- locked first, so two admins stocking in at once queue instead of colliding.
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


-- What actually went out of the door. sales holds one row per unit sold, so a
-- sale_addons row reads as "this unit went out with N of these". sale_id NOT
-- NULL is rule 3 expressed as a foreign key. Nothing here touches what the
-- customer pays: total_cost is what the giveaway cost the organization.
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
  -- copied off the batch, so a later catalogue price change never rewrites the
  -- profit of a sale that already happened.
  unit_cost       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total_cost      NUMERIC(12,2) GENERATED ALWAYS AS (unit_cost * quantity) STORED,
  list_value      NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- sale_id is intentionally absent: it is NOT NULL by design (rule 3 — an add-on
-- cannot exist without the sale it went out on), and a NOT NULL column with no
-- default cannot be bolted onto a table that already has rows. If sale_addons
-- exists without it, that is a different table and the CREATE above is not what
-- built it.
ALTER TABLE public.sale_addons
  ADD COLUMN IF NOT EXISTS addon_id        UUID REFERENCES public.addons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_id        UUID REFERENCES public.addon_stock_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS org_id          UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS addon_name      TEXT,
  ADD COLUMN IF NOT EXISTS addon_code      TEXT,
  ADD COLUMN IF NOT EXISTS addon_image_url TEXT,
  ADD COLUMN IF NOT EXISTS quantity        INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost      NUMERIC(12,2) GENERATED ALWAYS AS (unit_cost * quantity) STORED,
  ADD COLUMN IF NOT EXISTS list_value      NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS sale_addons_sale_idx  ON public.sale_addons (sale_id);
CREATE INDEX IF NOT EXISTS sale_addons_org_idx   ON public.sale_addons (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sale_addons_addon_idx ON public.sale_addons (addon_id);
CREATE INDEX IF NOT EXISTS sale_addons_batch_idx ON public.sale_addons (batch_id);

ALTER TABLE public.sale_addons ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sale_addons FROM PUBLIC, anon, authenticated;
-- Deliberately no INSERT/UPDATE grant: add-on stock is consumable only through
-- addon_attach_to_sale(), which requires a sale.
GRANT SELECT, DELETE ON public.sale_addons TO authenticated;
GRANT ALL ON public.sale_addons TO service_role;

DROP POLICY IF EXISTS "Members can view org sale addons"  ON public.sale_addons;
DROP POLICY IF EXISTS "Admins can delete org sale addons" ON public.sale_addons;

CREATE POLICY "Members can view org sale addons"
  ON public.sale_addons FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can delete org sale addons"
  ON public.sale_addons FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

-- Removing an add-on line puts the units back on the shelf — including when the
-- whole sale is deleted and cascades here. Clamped at the batch's original
-- quantity so a double restore cannot inflate stock.
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


-- One supplier run can carry machines and add-ons under one receipt. The two
-- spends stay apart so "what did we spend on machinery" is still answerable.
-- total_cost / unit_count keep their machinery-only meaning.
ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS addon_unit_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addon_cost       NUMERIC NOT NULL DEFAULT 0;


-- The only door into add-on stock. Consumes p_qty units oldest-batch-first,
-- writes one sale_addons row per batch drawn from, and returns what the giveaway
-- cost — the amount that comes off the sale's profit.
--
-- SECURITY DEFINER because it writes a table `authenticated` cannot insert into.
-- Everything it trusts is re-derived from the JWT: the org from current_org_id(),
-- and the sale must already exist in that org — which is what makes "an add-on
-- cannot be sold without an item" true in the database. Any member may call it;
-- giving an add-on away is part of ringing up a sale. If stock runs out mid-loop
-- it raises, and the function body being atomic rolls the partial consumption
-- back.
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

  -- FIFO. FOR UPDATE holds each batch for the rest of the transaction, so two
  -- tills selling the last case cannot both take it.
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

-- Checkout attaches add-ons to many sale rows at once. One call, one
-- transaction: every add-on on the cart lands, or none do.
-- p_lines: [{"sale_id": "...", "addon_id": "...", "qty": 2}, …]
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

-- security_invoker: these run with the CALLER's privileges, so the RLS on the
-- tables underneath applies through them. Without it a view is a hole straight
-- past the tenant boundary.
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

-- Join into the ledger, the sale detail drawer and the profit series:
-- profit = selling_price - unit cost - addon_cost.
CREATE OR REPLACE VIEW public.sale_addon_totals
WITH (security_invoker = on) AS
SELECT
  sa.sale_id,
  sa.org_id,
  SUM(sa.quantity)::INTEGER        AS addon_units,
  SUM(sa.total_cost)               AS addon_cost,
  SUM(sa.list_value * sa.quantity) AS addon_list_value
FROM public.sale_addons sa
GROUP BY sa.sale_id, sa.org_id;

REVOKE ALL ON public.addon_stock_levels FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sale_addon_totals  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.addon_stock_levels TO authenticated;
GRANT SELECT ON public.sale_addon_totals  TO authenticated;


-- ---------------------------------------------------------------------------
-- 15. Default privileges for anything added later
-- ---------------------------------------------------------------------------
-- Supabase ships defaults that hand BOTH `anon` and `authenticated` full DML on
-- every new table in public. Revoking them means the next table someone creates
-- is closed until its grants are written, rather than open until someone
-- notices.
--
-- `authenticated` matters as much as `anon` here. Each table above does
-- `REVOKE ALL ... FROM PUBLIC, anon, authenticated` and then grants back exactly
-- what that table needs — which is the only reason a claim like "authenticated
-- has no INSERT on sale_addons" is true. Without the revoke, the default grant
-- survives and the GRANT line reads like a whitelist while actually being an
-- addition to one. RLS still denied those writes (a table with RLS on and no
-- policy for a command denies it), but that left one layer doing the work of
-- two.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;


-- ---------------------------------------------------------------------------
-- 16. Tell PostgREST about all of the above
-- ---------------------------------------------------------------------------
-- PostgREST answers from a cached copy of the schema. Until it reloads, a table
-- that plainly exists in SQL still 404s through the API as
-- "Could not find the table 'public.addons' in the schema cache" — which reads
-- like the migration never ran. Supabase normally reloads on DDL, but the event
-- can be missed on a large script like this one, so ask explicitly.
NOTIFY pgrst, 'reload schema';
