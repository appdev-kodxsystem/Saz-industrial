-- ---------------------------------------------------------------------------
-- Receipt images on sales, and an org-scoped receipts bucket
-- ---------------------------------------------------------------------------
-- Two changes that only make sense together:
--
-- 1. `sale_orders` gains `receipt_path`, so a counter sale can carry a signed
--    slip or a photo of what went out the door — the same way a purchase has
--    carried the supplier's receipt since stock_orders was introduced.
--
-- 2. The `receipts` bucket stops being owner-scoped. Reads were restricted to
--    `owner_id = auth.uid()`, so a receipt attached by an employee could not be
--    opened by the admin reviewing the books. Since employees are exactly who
--    rings up sales, shipping (1) on top of the old policy would have produced
--    images only their uploader could ever see.

ALTER TABLE public.sale_orders
  ADD COLUMN IF NOT EXISTS receipt_path TEXT;

DROP POLICY IF EXISTS "Authenticated can read receipts"     ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own receipts"   ON storage.objects;
DROP POLICY IF EXISTS "Users can upload receipts"           ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own receipts" ON storage.objects;
DROP POLICY IF EXISTS "Org members can read receipts"         ON storage.objects;
DROP POLICY IF EXISTS "Org members can upload receipts"       ON storage.objects;
DROP POLICY IF EXISTS "Uploader or admin can update receipts" ON storage.objects;
DROP POLICY IF EXISTS "Uploader or admin can delete receipts" ON storage.objects;

-- A receipt belongs to the ORGANIZATION that recorded the transaction, not to
-- whoever happened to be holding the phone. The previous policy scoped reads to
-- `owner_id = auth.uid()`, which meant an employee's receipt was invisible to
-- the admin reviewing the books — the one person who most needs to see it.
--
-- Scope on the org folder instead. New uploads MUST start with the caller's org
-- id (the INSERT check enforces it), so the path itself carries the tenant.
-- Reads also accept the org id in the second segment, because the purchase flow
-- shipped earlier writes `stock-orders/<org_id>/…`; without that, receipts
-- recorded before this change would become unreadable to everyone.
CREATE POLICY "Org members can read receipts"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'receipts'
    AND (select public.current_org_id())::text IN (
      (storage.foldername(name))[1],
      (storage.foldername(name))[2]
    )
  );

CREATE POLICY "Org members can upload receipts"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] = (select public.current_org_id())::text
  );

-- Changing or removing a receipt is not the same as reading one: it rewrites
-- the evidence behind a recorded transaction. Left to the person who attached
-- it and to org admins.
CREATE POLICY "Uploader or admin can update receipts"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] = (select public.current_org_id())::text
    AND (COALESCE(owner_id, owner::text) = (select auth.uid())::text
         OR (select public.is_org_admin()))
  )
  WITH CHECK (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] = (select public.current_org_id())::text
  );

CREATE POLICY "Uploader or admin can delete receipts"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'receipts'
    AND (select public.current_org_id())::text IN (
      (storage.foldername(name))[1],
      (storage.foldername(name))[2]
    )
    AND (COALESCE(owner_id, owner::text) = (select auth.uid())::text
         OR (select public.is_org_admin()))
  );

NOTIFY pgrst, 'reload schema';
