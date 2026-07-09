-- ============================================================================
-- SECURITY FIX: sales and stock_items were created without RLS.
-- ============================================================================
-- Both tables were created in 20260605120000_add_stock_items_and_sales.sql with
-- no ALTER TABLE ... ENABLE ROW LEVEL SECURITY and no policies. Supabase's
-- default privileges grant `anon` and `authenticated` full DML on new tables in
-- public, so with RLS off every row was readable and writable by anyone holding
-- the publishable key — which ships in the browser bundle. That exposed every
-- tenant's sales, prices, customer names and customer contacts.
--
-- This is not mitigated by the server layer: requireSupabaseAuth
-- (src/integrations/supabase/auth-middleware.ts) builds its client from the
-- ANON key plus the caller's JWT, so RLS is the only tenant boundary the
-- inventory queries have. The service-role client is not used by them.
--
-- Every write path in src/lib/inventory.functions.ts already sets
-- user_id = context.userId (addStockEntries, buildSaleRow), so the policies
-- below match what the app already does. No application change is required.
--
-- Additive and idempotent. No table is dropped, no row is modified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Preflight: rows with a NULL user_id become invisible to clients once RLS is
-- on, because NULL = auth.uid() is NULL, not true. The user_id backfill in the
-- 20260609* migrations only reached rows whose product still existed. Warn
-- loudly rather than failing, so the security fix is never blocked by data.
-- Inspect with:  SELECT * FROM public.sales WHERE user_id IS NULL;
-- Reattach with: UPDATE public.sales SET user_id = '<uid>' WHERE id = '<id>';
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_sales INTEGER;
  orphan_items INTEGER;
BEGIN
  SELECT count(*) INTO orphan_sales FROM public.sales       WHERE user_id IS NULL;
  SELECT count(*) INTO orphan_items FROM public.stock_items WHERE user_id IS NULL;

  IF orphan_sales > 0 OR orphan_items > 0 THEN
    RAISE WARNING
      'RLS enabled with % orphaned sales row(s) and % orphaned stock_items row(s) (user_id IS NULL). These are now reachable only via service_role. Reassign their user_id to restore them.',
      orphan_sales, orphan_items;
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- stock_items
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stock_items FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_items TO authenticated;
GRANT ALL ON public.stock_items TO service_role;

DROP POLICY IF EXISTS "Users can view their own stock items"   ON public.stock_items;
DROP POLICY IF EXISTS "Users can insert their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can update their own stock items" ON public.stock_items;
DROP POLICY IF EXISTS "Users can delete their own stock items" ON public.stock_items;

CREATE POLICY "Users can view their own stock items"
  ON public.stock_items FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert their own stock items"
  ON public.stock_items FOR INSERT
  TO authenticated WITH CHECK ((select auth.uid()) = user_id);

-- USING gates which rows are visible to the UPDATE; WITH CHECK repeats the
-- predicate so the row cannot be reassigned to a different user on the way out.
CREATE POLICY "Users can update their own stock items"
  ON public.stock_items FOR UPDATE
  TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own stock items"
  ON public.stock_items FOR DELETE
  TO authenticated USING ((select auth.uid()) = user_id);


-- ---------------------------------------------------------------------------
-- sales
-- ---------------------------------------------------------------------------
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

-- Covers settlePayment(), which writes net_payment + payment_status.
CREATE POLICY "Users can update their own sales"
  ON public.sales FOR UPDATE
  TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own sales"
  ON public.sales FOR DELETE
  TO authenticated USING ((select auth.uid()) = user_id);


-- ---------------------------------------------------------------------------
-- receipts bucket: was readable by any authenticated user
-- ---------------------------------------------------------------------------
-- The previous policies gated only on bucket_id = 'receipts', so any signed-in
-- user could list, download, overwrite or delete every other tenant's receipt
-- files. The app uploads to a shared `receipts/cart/` prefix, so the object path
-- carries no user id to scope on. Scope on the uploader instead: storage stamps
-- owner_id from the caller's JWT and it is not client-settable.
--
-- INSERT stays gated on bucket_id alone, because owner_id is assigned by the
-- storage layer during the insert — checking it in WITH CHECK would reject the
-- upload in src/components/cart/CartDrawer.tsx.
--
-- Nothing in the app reads from this bucket today, so tightening SELECT is
-- inert for the UI. Receipts uploaded before this migration keep their
-- owner_id and stay visible to the uploader.
DROP POLICY IF EXISTS "Authenticated can read receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload receipts" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update receipts" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete receipts" ON storage.objects;

DROP POLICY IF EXISTS "Users can read their own receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Users can upload receipts"           ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own receipts" ON storage.objects;

-- `owner` is the legacy uuid column, `owner_id` the current text one.
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
-- Close the default that opened this hole in the first place
-- ---------------------------------------------------------------------------
-- Supabase's default privileges hand `anon` full DML on every new table in
-- public. Revoking them means the next table created is closed until its
-- policies are written, instead of open until someone notices.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
