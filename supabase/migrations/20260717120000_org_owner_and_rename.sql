-- ============================================================================
-- Organization owner + renaming
-- ============================================================================
-- Until now every admin was interchangeable, so one admin could demote or delete
-- another — including the person who created the organization. Give the org a
-- distinguished OWNER: the member who created it. The owner cannot be demoted,
-- cannot be removed, and cannot be deleted by anyone, including other admins.
-- The UI hides those actions; these functions are what actually enforce it.
--
-- Also moves renaming behind a SECURITY DEFINER function. The old policy granted
-- admins a blanket UPDATE on organizations, and RLS cannot restrict columns — so
-- an admin could have PATCHed `owner_id` onto themselves and seized the org. The
-- rename function can touch nothing but `name`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. organizations.owner_id
-- ---------------------------------------------------------------------------
-- SET NULL rather than CASCADE: an org must never be deleted as a side effect of
-- deleting a user. (The owner can't be removed anyway — this is belt and braces.)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill: existing orgs predate the column. The creator is the earliest active
-- admin — self-signup makes the creator an admin before anyone else can join.
UPDATE public.organizations o
SET owner_id = m.user_id
FROM (
  SELECT DISTINCT ON (org_id) org_id, user_id
  FROM public.organization_members
  WHERE role = 'admin' AND status = 'active' AND user_id IS NOT NULL
  ORDER BY org_id, created_at
) m
WHERE m.org_id = o.id
  AND o.owner_id IS NULL;


-- ---------------------------------------------------------------------------
-- 2. handle_new_user — stamp the creator as owner
-- ---------------------------------------------------------------------------
-- Unchanged except that the self-signup branch now records owner_id. Still reads
-- nothing about org or role from raw_user_meta_data (that is client-controlled;
-- see the 20260714 migration).
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


-- ---------------------------------------------------------------------------
-- 3. Is this membership row the owner?
-- ---------------------------------------------------------------------------
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

REVOKE EXECUTE ON FUNCTION public.is_org_owner_member(UUID) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Renaming — name only, admins only
-- ---------------------------------------------------------------------------
-- Replaces the blanket UPDATE policy. RLS has no column-level security, so that
-- policy would also have permitted `owner_id` to be rewritten via PostgREST.
DROP POLICY IF EXISTS "Admins can rename their organization" ON public.organizations;
REVOKE UPDATE ON public.organizations FROM authenticated;

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

REVOKE EXECUTE ON FUNCTION public.org_rename(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_rename(TEXT) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. The owner is untouchable
-- ---------------------------------------------------------------------------
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

  -- Sales and products survive (those FKs are ON DELETE SET NULL). The account
  -- itself is deleted by the caller — see removeMember in src/lib/org.functions.ts.
  DELETE FROM public.organization_members
  WHERE id = p_member_id AND org_id = v_org_id;

  RETURN v_user;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.org_remove_member(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_remove_member(UUID) TO authenticated;


-- ---------------------------------------------------------------------------
-- 6. org_list_members — flag the owner so the UI can hide their action menu
-- ---------------------------------------------------------------------------
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

REVOKE EXECUTE ON FUNCTION public.org_list_members() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.org_list_members() TO authenticated;
