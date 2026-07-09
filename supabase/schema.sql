-- ============================================================================
-- SAZ-Industrial — canonical schema (tables, RLS, policies, grants, storage)
-- ============================================================================
-- Consolidates every migration under supabase/migrations into one script that
-- reproduces the database from scratch, with the security gaps closed.
--
-- Idempotent: safe to re-run. It never drops a table and never deletes a row.
--
-- Security model
--   * Every table is RLS-enabled and scoped to `user_id = auth.uid()`
--     (`id = auth.uid()` for profiles). Ownership is enforced in the database,
--     not in application code.
--   * Server functions (src/lib/inventory.functions.ts) run through
--     requireSupabaseAuth, which builds a Supabase client from the ANON key
--     plus the caller's JWT. RLS is therefore the only tenant boundary those
--     queries have. The service-role key (client.server.ts) bypasses RLS and is
--     currently unused by the inventory layer.
--   * `anon` gets no table privileges. Its only reachable surface is the
--     email_exists() RPC.
--   * Policies use `(select auth.uid())` rather than a bare `auth.uid()` so
--     Postgres hoists the call into an InitPlan and evaluates it once per
--     statement instead of once per row.
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
-- 3. Auto-provision a profile on signup
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: fires as the auth.users owner, so it can write a profile
-- row before the new user has a session of their own.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ---------------------------------------------------------------------------
-- 4. products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE INDEX IF NOT EXISTS products_user_id_idx     ON public.products(user_id);
CREATE INDEX IF NOT EXISTS products_user_pinned_idx ON public.products(user_id, pinned DESC, updated_at DESC);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.products FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;

DROP POLICY IF EXISTS "Users can view their own products"   ON public.products;
DROP POLICY IF EXISTS "Users can insert their own products" ON public.products;
DROP POLICY IF EXISTS "Users can update their own products" ON public.products;
DROP POLICY IF EXISTS "Users can delete their own products" ON public.products;

CREATE POLICY "Users can view their own products"
  ON public.products FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert their own products"
  ON public.products FOR INSERT
  TO authenticated WITH CHECK ((select auth.uid()) = user_id);

-- WITH CHECK repeats the predicate so a row cannot be reassigned to another user.
CREATE POLICY "Users can update their own products"
  ON public.products FOR UPDATE
  TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own products"
  ON public.products FOR DELETE
  TO authenticated USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS products_set_updated_at ON public.products;
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 5. stock_items — one row per physical unit
-- ---------------------------------------------------------------------------
-- product_id is ON DELETE SET NULL, and name/sku/image are snapshotted at
-- stock-in, so purchase history outlives the product it came from. user_id is
-- what keeps the row addressable once product_id goes NULL — it is the RLS key.
CREATE TABLE IF NOT EXISTS public.stock_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID REFERENCES public.products(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_stock_items_user_id      ON public.stock_items(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_user_created ON public.stock_items(user_id, created_at DESC);

ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stock_items FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_items TO authenticated;
GRANT ALL ON public.stock_items TO service_role;

DROP POLICY IF EXISTS "Users can view their own stock items"   ON public.stock_items;
DROP POLICY IF EXISTS "Users can insert their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can update their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can delete their own stock items" ON public.stock_items;

-- NULL user_id fails every predicate below, so such rows are invisible to
-- clients and reachable only via service_role. That is deliberate: fail closed.
CREATE POLICY "Users can view their own stock items"
  ON public.stock_items FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert their own stock items"
  ON public.stock_items FOR INSERT
  TO authenticated WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update their own stock items"
  ON public.stock_items FOR UPDATE
  TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own stock items"
  ON public.stock_items FOR DELETE
  TO authenticated USING ((select auth.uid()) = user_id);


-- ---------------------------------------------------------------------------
-- 6. sales — one row per unit sold
-- ---------------------------------------------------------------------------
-- Holds customer PII (name, contact) and full pricing, so it is the most
-- sensitive table here. Both FKs are ON DELETE SET NULL so a sale, and any
-- outstanding balance on it, survives deletion of the product or stock item.
CREATE TABLE IF NOT EXISTS public.sales (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID REFERENCES public.products(id) ON DELETE SET NULL,
  stock_item_id      UUID REFERENCES public.stock_items(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_sales_user_id      ON public.sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_user_created ON public.sales(user_id, created_at DESC);

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sales FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales TO authenticated;
GRANT ALL ON public.sales TO service_role;

DROP POLICY IF EXISTS "Users can view their own sales"   ON public.sales;
DROP POLICY IF EXISTS "Users can insert their own sales" ON public.sales;
DROP POLICY IF EXISTS "Users can update their own sales" ON public.sales;
DROP POLICY IF EXISTS "Users can delete their own sales" ON public.sales;

CREATE POLICY "Users can view their own sales"
  ON public.sales FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert their own sales"
  ON public.sales FOR INSERT
  TO authenticated WITH CHECK ((select auth.uid()) = user_id);

-- settlePayment() updates net_payment + payment_status here.
CREATE POLICY "Users can update their own sales"
  ON public.sales FOR UPDATE
  TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own sales"
  ON public.sales FOR DELETE
  TO authenticated USING ((select auth.uid()) = user_id);


-- ---------------------------------------------------------------------------
-- 7. email_exists() — anon-callable account probe
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
-- 8. Storage: avatars (public read, owner-only write)
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
-- 9. Storage: receipts (private, owner-scoped)
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
-- 10. Default privileges for anything added later
-- ---------------------------------------------------------------------------
-- Supabase ships defaults that hand `anon` full DML on every new table in
-- public. Revoking them means the next table someone creates is closed until
-- its policies are written, rather than open until someone notices.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
