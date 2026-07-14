-- ============================================================================
-- Organizations + roles
-- ============================================================================
-- Moves the tenant boundary from the individual user to the organization.
--
-- Before this migration every table was scoped `user_id = auth.uid()`, so two
-- people could never see the same inventory. An organization has many members;
-- they all read the same products, stock and sales. `user_id` survives on each
-- row as an audit trail ("who did this"), but it is no longer the RLS key —
-- `org_id` is.
--
-- Roles (fixed, two of them):
--   admin     — everything. Products, stock, purchases, reports, team.
--   employee  — reads inventory, sells, settles payments. Cannot create, edit
--               or delete a product or a stock unit, and cannot see purchase
--               cost or profit (Purchases + Reports are admin-only routes).
--
-- Role enforcement lives in RLS, not in the UI. Hiding a button is a courtesy;
-- the policies below are the actual boundary.
--
-- DESTRUCTIVE: products, stock_items and sales are emptied. org_id is NOT NULL
-- and pre-org rows have no organization to belong to. This was a deliberate
-- choice — see the plan discussion. Do not run against data you want to keep.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. organizations
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- 2. organization_members
-- ---------------------------------------------------------------------------
-- One row per person in an org. The row is created when the admin invites the
-- email — at that point `user_id` is NULL and status is 'pending'. When the
-- invitee accepts and an auth.users row appears, handle_new_user() claims the
-- pending row: sets user_id and flips status to 'active'.
--
-- `user_id` is UNIQUE: a user belongs to exactly one organization. That keeps
-- current_org_id() a single unambiguous lookup and means no org switcher in the
-- UI. Revisit if multi-org membership is ever needed.
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

-- An email appears at most once per org, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS organization_members_org_email_idx
  ON public.organization_members (org_id, lower(email));
-- Backs the pending-invite claim in handle_new_user().
CREATE INDEX IF NOT EXISTS organization_members_email_lower_idx
  ON public.organization_members (lower(email));
CREATE INDEX IF NOT EXISTS organization_members_org_id_idx
  ON public.organization_members (org_id);

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS organization_members_set_updated_at ON public.organization_members;
CREATE TRIGGER organization_members_set_updated_at
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 3. Membership lookups used by every policy below
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER is load-bearing, not incidental: these read
-- organization_members, and organization_members' own policies call them. A
-- plain function would recurse (policy -> function -> policy -> ...). DEFINER
-- runs as the owner and skips RLS on the inner read, which breaks the cycle.
--
-- STABLE lets Postgres hoist the call into an InitPlan: once per statement
-- rather than once per row.
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT org_id
  FROM public.organization_members
  WHERE user_id = (select auth.uid())
    AND status = 'active'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_org_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role
  FROM public.organization_members
  WHERE user_id = (select auth.uid())
    AND status = 'active'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE user_id = (select auth.uid())
      AND status = 'active'
      AND role = 'admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.current_org_id()   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_org_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin()     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_org_id()   TO authenticated;
GRANT  EXECUTE ON FUNCTION public.current_org_role() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_org_admin()     TO authenticated;


-- ---------------------------------------------------------------------------
-- 4. Policies on the org tables themselves
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.organizations       FROM PUBLIC, anon;
REVOKE ALL ON public.organization_members FROM PUBLIC, anon;
GRANT SELECT          ON public.organizations        TO authenticated;
GRANT UPDATE          ON public.organizations        TO authenticated;
GRANT SELECT          ON public.organization_members TO authenticated;
GRANT ALL             ON public.organizations        TO service_role;
GRANT ALL             ON public.organization_members TO service_role;

DROP POLICY IF EXISTS "Members can view their organization"   ON public.organizations;
DROP POLICY IF EXISTS "Admins can rename their organization"  ON public.organizations;

CREATE POLICY "Members can view their organization"
  ON public.organizations FOR SELECT
  TO authenticated USING (id = (select public.current_org_id()));

CREATE POLICY "Admins can rename their organization"
  ON public.organizations FOR UPDATE
  TO authenticated
  USING      (id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (id = (select public.current_org_id()) AND (select public.is_org_admin()));

-- Organizations are only ever created by handle_new_user() (SECURITY DEFINER)
-- or by service_role, so `authenticated` gets no INSERT/DELETE at all.

DROP POLICY IF EXISTS "Members can view their teammates" ON public.organization_members;

CREATE POLICY "Members can view their teammates"
  ON public.organization_members FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

-- Membership writes (invite, role change, removal) go exclusively through
-- service_role in src/lib/org.functions.ts, which checks the caller is an admin
-- of that org first. `authenticated` therefore gets no INSERT/UPDATE/DELETE
-- grant here — an employee cannot promote themselves by hitting PostgREST.


-- ---------------------------------------------------------------------------
-- 5. Re-scope the data tables from user to organization
-- ---------------------------------------------------------------------------
-- The wipe is guarded on org_id not existing yet, so it happens exactly once —
-- on the first run, when the tables still hold pre-org rows. Re-running this
-- migration later is then a no-op rather than a data loss event.
--
-- Order matters: children before parents (sales references stock_items).
-- Emptying these is what lets org_id be NOT NULL with no backfill.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'org_id'
  ) THEN
    DELETE FROM public.sales;
    DELETE FROM public.stock_items;
    DELETE FROM public.products;
  END IF;
END;
$$;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE;

-- org_id is now the filter on every read, so it leads every composite index.
-- The old user_id indexes are dead weight: user_id is audit metadata now and is
-- never a query predicate.
DROP INDEX IF EXISTS public.products_user_id_idx;
DROP INDEX IF EXISTS public.products_user_pinned_idx;
DROP INDEX IF EXISTS public.idx_stock_items_user_id;
DROP INDEX IF EXISTS public.idx_stock_items_user_created;
DROP INDEX IF EXISTS public.idx_sales_user_id;
DROP INDEX IF EXISTS public.idx_sales_user_created;

CREATE INDEX IF NOT EXISTS products_org_id_idx        ON public.products(org_id);
CREATE INDEX IF NOT EXISTS products_org_pinned_idx    ON public.products(org_id, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS stock_items_org_id_idx     ON public.stock_items(org_id);
CREATE INDEX IF NOT EXISTS stock_items_org_created_idx ON public.stock_items(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_org_id_idx           ON public.sales(org_id);
CREATE INDEX IF NOT EXISTS sales_org_created_idx      ON public.sales(org_id, created_at DESC);


-- ---------------------------------------------------------------------------
-- 6. products — read: any member. write: admins only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view their own products"   ON public.products;
DROP POLICY IF EXISTS "Users can insert their own products" ON public.products;
DROP POLICY IF EXISTS "Users can update their own products" ON public.products;
DROP POLICY IF EXISTS "Users can delete their own products" ON public.products;
DROP POLICY IF EXISTS "Members can view org products"    ON public.products;
DROP POLICY IF EXISTS "Admins can insert org products"   ON public.products;
DROP POLICY IF EXISTS "Admins can update org products"   ON public.products;
DROP POLICY IF EXISTS "Admins can delete org products"   ON public.products;

CREATE POLICY "Members can view org products"
  ON public.products FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Admins can insert org products"
  ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

-- WITH CHECK repeats the predicate so an admin cannot move a product into
-- another org.
CREATE POLICY "Admins can update org products"
  ON public.products FOR UPDATE
  TO authenticated
  USING      (org_id = (select public.current_org_id()) AND (select public.is_org_admin()))
  WITH CHECK (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));

CREATE POLICY "Admins can delete org products"
  ON public.products FOR DELETE
  TO authenticated
  USING (org_id = (select public.current_org_id()) AND (select public.is_org_admin()));


-- ---------------------------------------------------------------------------
-- 7. stock_items — read: any member. insert/delete: admins. update: any member.
-- ---------------------------------------------------------------------------
-- UPDATE stays open to employees because selling a unit flips sold/sold_at on
-- this table. INSERT (stock-in) and DELETE remain admin-only, which is the
-- "employees cannot add stock" rule.
DROP POLICY IF EXISTS "Users can view their own stock items"   ON public.stock_items;
DROP POLICY IF EXISTS "Users can insert their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can update their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can delete their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Members can view org stock items"   ON public.stock_items;
DROP POLICY IF EXISTS "Admins can insert org stock items"  ON public.stock_items;
DROP POLICY IF EXISTS "Members can update org stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Admins can delete org stock items"  ON public.stock_items;

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
-- 8. sales — read/insert/update: any member. delete: admins.
-- ---------------------------------------------------------------------------
-- Employees sell (INSERT) and settle pending payments (UPDATE). Only an admin
-- can erase a sale.
DROP POLICY IF EXISTS "Users can view their own sales"   ON public.sales;
DROP POLICY IF EXISTS "Users can insert their own sales" ON public.sales;
DROP POLICY IF EXISTS "Users can update their own sales" ON public.sales;
DROP POLICY IF EXISTS "Users can delete their own sales" ON public.sales;
DROP POLICY IF EXISTS "Members can view org sales"   ON public.sales;
DROP POLICY IF EXISTS "Members can insert org sales" ON public.sales;
DROP POLICY IF EXISTS "Members can update org sales" ON public.sales;
DROP POLICY IF EXISTS "Admins can delete org sales"  ON public.sales;

CREATE POLICY "Members can view org sales"
  ON public.sales FOR SELECT
  TO authenticated USING (org_id = (select public.current_org_id()));

CREATE POLICY "Members can insert org sales"
  ON public.sales FOR INSERT
  TO authenticated
  WITH CHECK (org_id = (select public.current_org_id()));

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
-- Rather than widen that policy (which would also let employees rewrite prices,
-- names and reorder points), the stock counter gets its own narrow door: a
-- SECURITY DEFINER function that can change *nothing but* `stock`, and only on
-- a product in the caller's own org.
--
-- Clamped at zero, mirroring the application logic it replaces.
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

  -- This function is granted to `authenticated`, so an employee can invoke it
  -- directly, not only through the app. Two guards make that safe:
  --
  --   * A POSITIVE delta means adding to the counter (stock-in, an adjustment
  --     up). Only admins do that. Without this check an employee could inflate
  --     any product's stock at will — exactly the "employees cannot add stock"
  --     rule this whole design turns on. A negative delta is a sale decrement,
  --     which every member may do.
  --   * The magnitude is bounded either way, so no single call can swing the
  --     counter to an absurd value. Legitimate callers stay well inside this:
  --     a cart sells at most 200 units.
  IF p_delta > 0 AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Only an admin can increase stock';
  END IF;
  IF abs(p_delta) > 100000 THEN
    RAISE EXCEPTION 'Stock change out of range';
  END IF;

  -- The org check is inside the UPDATE, so a product in someone else's org
  -- simply matches no row — it never leaks whether that id exists.
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
-- 10. handle_new_user() — provision profile, then place the user in an org
-- ---------------------------------------------------------------------------
-- Three paths, in order:
--
--   a. A pending invite exists for this email. The admin created that row
--      before sending the invite, so claim it: attach user_id, go active. The
--      invitee lands in the admin's org with the role the admin chose.
--
--   b. No pending invite — an ordinary self-signup. Give them a fresh
--      organization and make them its admin. Every user is therefore always in
--      exactly one org, which is what lets current_org_id() be non-null for
--      everyone.
--
-- SECURITY: this function deliberately reads NOTHING that decides org or role
-- from raw_user_meta_data. That field is a verbatim copy of the client-supplied
-- options.data on signUp, sent with the anon key, so it is fully attacker
-- controlled. An earlier draft trusted a metadata `org_id`/`org_role` here,
-- which let anyone who knew an org's UUID sign up a second account as its admin.
-- Placement into an existing org happens ONLY by claiming a pending invite row
-- that an admin of that org created — never from anything the signer-up said.
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
  WHERE lower(email) = lower(NEW.email)
    AND user_id IS NULL
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

  INSERT INTO public.organizations (name)
  VALUES (v_org_name)
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
-- 11. Membership writes — SECURITY DEFINER, admin-checked in the database
-- ---------------------------------------------------------------------------
-- `authenticated` deliberately has no INSERT/UPDATE/DELETE grant on
-- organization_members (section 4), so an employee cannot promote themselves by
-- hitting PostgREST directly. These four functions are the only way in, and each
-- one re-derives the caller's org and admin status from their JWT — none of it
-- is passed in, so none of it can be forged.
--
-- Doing this in the database rather than with a service-role client in Node
-- keeps the app's privilege floor low: the server never needs a key that
-- bypasses RLS in order to manage a team. The one thing that still does need the
-- real service-role key is *sending the invite email*, which is Supabase's admin
-- Auth API, not SQL.

-- Everyone in the caller's org, with profile name/avatar where one exists.
-- profiles' own RLS only exposes a user's own row, which is why this is DEFINER:
-- it lets a member see their teammates' names without opening profiles up.
CREATE OR REPLACE FUNCTION public.org_list_members()
RETURNS TABLE (
  id           UUID,
  user_id      UUID,
  email        TEXT,
  role         TEXT,
  status       TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT m.id, m.user_id, m.email, m.role, m.status,
         p.display_name, p.avatar_url, m.created_at
  FROM public.organization_members m
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.org_id = public.current_org_id()
  ORDER BY m.created_at;
$$;

-- Create the pending membership row for an invitee. Returns its id so the caller
-- can delete it again if the invite email then fails to send.
CREATE OR REPLACE FUNCTION public.org_invite_member(p_email TEXT, p_role TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Undo the row above when the invite email fails. Restricted to rows that are
-- still pending, so this can never be used to evict an active teammate.
CREATE OR REPLACE FUNCTION public.org_discard_invite(p_member_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id    UUID;
  v_old_role  TEXT;
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

  -- An org with no admin is an org nobody can add a product to ever again.
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- them this org's rows on their very next request.
  DELETE FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;
END;
$$;

-- Shared guard: refuse a change that would leave `org_id` with no active admin,
-- counting admins other than the one being demoted or removed.
CREATE OR REPLACE FUNCTION public.assert_org_keeps_an_admin(p_org_id UUID, p_excluding UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

REVOKE EXECUTE ON FUNCTION public.org_list_members()                     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_invite_member(TEXT, TEXT)          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_discard_invite(UUID)               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_update_member_role(UUID, TEXT)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.org_remove_member(UUID)                FROM PUBLIC, anon;
-- Internal helper: only ever called by the two functions above.
REVOKE EXECUTE ON FUNCTION public.assert_org_keeps_an_admin(UUID, UUID)  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.org_list_members()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_invite_member(TEXT, TEXT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_discard_invite(UUID)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_update_member_role(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_remove_member(UUID)            TO authenticated;


-- ---------------------------------------------------------------------------
-- 12. Backfill: every existing auth user needs an organization
-- ---------------------------------------------------------------------------
-- The trigger only fires on new signups. Anyone who already had an account
-- predates it and would otherwise have current_org_id() = NULL — locked out of
-- every table. Give each of them their own org, as admin.
-- One user at a time: create the org, then immediately record the membership
-- that points at it. A set-based version would have to correlate the inserted
-- orgs back to their users after the fact, and there is no stable key to do it
-- on — every row lands with the same now() and a random uuid.
DO $$
DECLARE
  u        RECORD;
  v_org_id UUID;
BEGIN
  FOR u IN
    SELECT au.id,
           au.email,
           COALESCE(
             NULLIF(trim(p.company), ''),
             NULLIF(trim(p.display_name), ''),
             split_part(au.email, '@', 1)
           ) AS org_name
    FROM auth.users au
    LEFT JOIN public.profiles p ON p.id = au.id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.organization_members m WHERE m.user_id = au.id
    )
  LOOP
    INSERT INTO public.organizations (name)
    VALUES (u.org_name)
    RETURNING id INTO v_org_id;

    INSERT INTO public.organization_members (org_id, user_id, email, role, status)
    VALUES (v_org_id, u.id, u.email, 'admin', 'active');
  END LOOP;
END;
$$;
