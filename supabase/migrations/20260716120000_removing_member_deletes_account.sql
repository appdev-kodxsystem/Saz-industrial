-- ============================================================================
-- Removing a member deletes their account — without deleting the org's history
-- ============================================================================
-- A user belongs to exactly one organization. So once an admin removes someone
-- from the team, that account has no org, can reach nothing, and only serves to
-- squat on an email address (blocking any future re-invite, since Supabase
-- refuses to invite an address that already has an account). Removing a member
-- should therefore delete the auth user outright.
--
-- BUT: products.user_id, stock_items.user_id and sales.user_id are all still
-- `ON DELETE CASCADE` to auth.users, inherited from the single-user design where
-- the user WAS the tenant. Under the org model that is now catastrophic —
-- deleting an employee would cascade away every sale they ever rang up, and
-- deleting an admin would take the product catalogue with them. The org owns
-- that data now; user_id is only an audit stamp of who did it.
--
-- So repoint those three FKs at ON DELETE SET NULL first. The row survives the
-- person, exactly as it already survives a deleted product (same reasoning, same
-- mechanism as product_id/stock_item_id). Only then is deleting the account safe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. user_id: CASCADE -> SET NULL on the three data tables
-- ---------------------------------------------------------------------------
-- Drop by lookup rather than by assumed name: these constraints were created
-- across several earlier migrations and may not all be *_user_id_fkey.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS tbl
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid IN (
        'public.products'::regclass,
        'public.stock_items'::regclass,
        'public.sales'::regclass
      )
      AND att.attname = 'user_id'
      AND array_length(con.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END;
$$;

-- products.user_id was NOT NULL (the old tenant key). It has to be nullable now,
-- or SET NULL could not fire and deleting the member would still fail.
ALTER TABLE public.products ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.products
  ADD CONSTRAINT products_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.stock_items
  ADD CONSTRAINT stock_items_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES auth.users(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- 2. org_remove_member() — hand back the user_id so the caller can delete it
-- ---------------------------------------------------------------------------
-- Same guards as before (admin only, same org, not yourself, never the last
-- admin). The only change is the return value: the removed member's auth user
-- id, so the server can then delete the account through the admin Auth API.
-- Deleting an auth.users row is not something SQL should be doing behind
-- Supabase's back, so that half stays in org.functions.ts.
--
-- Returns NULL when the row was a never-claimed invite (no auth user to delete).
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

  DELETE FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;

  RETURN v_user;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.org_remove_member(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_remove_member(UUID) TO authenticated;
