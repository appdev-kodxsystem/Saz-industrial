-- Lets the (unauthenticated) forgot-password screen check whether an account
-- exists for an email, without exposing profile rows or needing a service-role
-- key. SECURITY DEFINER runs with the owner's rights and returns only a boolean.
CREATE OR REPLACE FUNCTION public.email_exists(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE lower(email) = lower(trim(p_email))
  );
$$;

GRANT EXECUTE ON FUNCTION public.email_exists(TEXT) TO anon, authenticated;
