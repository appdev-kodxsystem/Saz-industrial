import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/inventory/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { CartProvider } from "@/components/cart/cart-context";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { AddToCartDrawer } from "@/components/cart/AddToCartDrawer";
import { getMyOrg, MY_ORG_QUERY_KEY } from "@/lib/org.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    // getSession() reads the stored session locally; getUser() used to be called
    // here instead and went to Supabase's auth server on EVERY navigation, in
    // series with the getMyOrg() call below. That round trip was pure overhead:
    // getMyOrg() is a server function, and its middleware verifies the JWT
    // properly before answering. So the token still gets validated on every
    // navigation — just once, by the call we were making anyway, instead of
    // twice.
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.user) throw redirect({ to: "/auth" });

    // Resolve the org + role once, here, and hand it down through router
    // context. Every page and every admin-only route guard reads it from there,
    // so no component re-fetches it and there is a single source of truth for
    // "what is this person allowed to do".
    //
    // Read through the query client so that moving between pages reuses the
    // answer. beforeLoad re-runs on every navigation, and this used to mean a
    // full server round trip (JWT verification + membership lookup + two more
    // queries) before any page could start loading its own data.
    let membership: Awaited<ReturnType<typeof getMyOrg>>;
    try {
      membership = await context.queryClient.ensureQueryData({
        queryKey: MY_ORG_QUERY_KEY,
        queryFn: () => getMyOrg(),
        staleTime: 5 * 60_000,
        // The failures here are "not a member" and "bad token" — neither gets
        // better on a second attempt, and retrying only delays the sign-out.
        retry: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // A failed lookup must not be left in the cache, or a transient error
      // would stick around and keep failing until gcTime lapsed.
      context.queryClient.removeQueries({ queryKey: MY_ORG_QUERY_KEY });

      // Genuinely no membership — an admin removed this user while they were
      // signed in. Their JWT still works but RLS now returns them nothing, so
      // sign them out and send them to login rather than into an empty app.
      if (/do not belong to an organization/i.test(message)) {
        await supabase.auth.signOut();
        throw redirect({ to: "/auth" });
      }

      // The stored session did not survive server-side verification — it is
      // expired, revoked or forged. This is the case getUser() used to catch
      // here; the server function catches it now, so honour it the same way.
      if (/unauthorized/i.test(message)) {
        await supabase.auth.signOut();
        throw redirect({ to: "/auth" });
      }

      // Anything else (the org tables not migrated yet, a transient network
      // error) is a backend problem, NOT a reason to destroy the session and
      // bounce to login — that just looks like "login doesn't work". Surface
      // the real error instead, and keep the user signed in so a retry works
      // once the backend is fixed.
      throw new Error(
        `Could not load your organization: ${message}. ` +
          `If this project was just set up, apply the organizations migration ` +
          `(supabase/migrations) to the database.`,
      );
    }

    // An invited teammate already has an account (inviteUserByEmail creates it
    // up front) but has not chosen a password yet. Supabase's redirect_to is
    // supposed to land them on /reset-password, but that silently falls back to
    // the Site URL whenever the origin isn't on the Redirect URLs allowlist —
    // every Vercel preview domain, for instance — dropping them straight into
    // the app. So enforce it here instead of trusting the redirect: until they
    // have set a password, the only page they can reach is the one that sets it.
    if (!membership.passwordSet) {
      throw redirect({ to: "/reset-password" });
    }

    return {
      user: data.session.user,
      org: membership.org,
      role: membership.role,
      isAdmin: membership.role === "admin",
      // The person who created this organization. Permanently an admin — cannot
      // be demoted or removed by anyone, including other admins.
      isOwner: membership.isOwner,
      // The caller's own row in organization_members. The Organization page uses
      // it to recognise "you" and to stop an admin removing themselves.
      membershipId: membership.membershipId,
    };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  return (
    <CartProvider>
      <div className="min-h-dvh bg-background text-foreground">
        <Toaster position="top-right" />
        <AppShell>
          <Outlet />
        </AppShell>
        <CartDrawer />
        <AddToCartDrawer />
      </div>
    </CartProvider>
  );
}
