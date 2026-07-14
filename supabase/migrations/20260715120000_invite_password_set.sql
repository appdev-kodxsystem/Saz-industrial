-- ============================================================================
-- Force invited members through the set-password screen
-- ============================================================================
-- inviteUserByEmail creates the auth.users row at INVITE time, so the invitee
-- already has an account (and a claimable session) before they have ever chosen
-- a password. Which screen they first see was therefore left entirely up to
-- Supabase's redirect_to — and that is fragile: an origin missing from the
-- Redirect URLs allowlist (every Vercel preview domain, for one) silently falls
-- back to the Site URL and drops them straight into the app, password never set.
--
-- So stop relying on the redirect for correctness. Record the fact in our own
-- schema and let the app enforce it: `password_set = false` means "this person
-- has not chosen a password yet", and the authenticated layout bounces them to
-- /reset-password until they have, wherever they happened to land.
-- ============================================================================

-- Existing members already have passwords; only invitees start without one.
ALTER TABLE public.organization_members
  ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT true;


-- ---------------------------------------------------------------------------
-- org_invite_member — the invited row starts with no password
-- ---------------------------------------------------------------------------
-- Identical to the original except for `password_set = false` on the INSERT.
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

  INSERT INTO public.organization_members (org_id, email, role, status, invited_by, password_set)
  VALUES (v_org_id, v_email, p_role, 'pending', (select auth.uid()), false)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


-- ---------------------------------------------------------------------------
-- org_mark_password_set — the invitee closes the loop on themselves
-- ---------------------------------------------------------------------------
-- Called right after supabase.auth.updateUser({ password }) succeeds. Scoped to
-- the caller's own row via auth.uid(), so it can only ever clear the flag for
-- the person actually setting a password — it takes no arguments precisely so
-- that nobody can pass someone else's id.
CREATE OR REPLACE FUNCTION public.org_mark_password_set()
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.organization_members
     SET password_set = true
   WHERE user_id = (select auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.org_mark_password_set() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_mark_password_set() TO authenticated;


-- ---------------------------------------------------------------------------
-- org_list_members — surface password_set so the Team page can show it
-- ---------------------------------------------------------------------------
-- `status` flips to 'active' the moment inviteUserByEmail creates the account,
-- which is before the invitee has done anything — so it is a poor signal for
-- "invite still outstanding". password_set is the honest one, and the Team page
-- now badges on it instead.
--
-- DROP first: CREATE OR REPLACE cannot change a function's return type.
DROP FUNCTION IF EXISTS public.org_list_members();

CREATE FUNCTION public.org_list_members()
RETURNS TABLE (
  id UUID, user_id UUID, email TEXT, role TEXT, status TEXT,
  display_name TEXT, avatar_url TEXT, password_set BOOLEAN, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT m.id, m.user_id, m.email, m.role, m.status,
         p.display_name, p.avatar_url, m.password_set, m.created_at
  FROM public.organization_members m
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.org_id = public.current_org_id()
  ORDER BY m.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.org_list_members() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_list_members() TO authenticated;
