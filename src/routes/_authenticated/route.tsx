import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/inventory/AppNav";
import { Toaster } from "@/components/ui/sonner";
import { CartProvider } from "@/components/cart/cart-context";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { AddToCartDrawer } from "@/components/cart/AddToCartDrawer";
import { getMyOrg } from "@/lib/org.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });

    // Resolve the org + role once, here, and hand it down through router
    // context. Every page and every admin-only route guard reads it from there,
    // so no component re-fetches it and there is a single source of truth for
    // "what is this person allowed to do".
    let membership: Awaited<ReturnType<typeof getMyOrg>>;
    try {
      membership = await getMyOrg();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Genuinely no membership — an admin removed this user while they were
      // signed in. Their JWT still works but RLS now returns them nothing, so
      // sign them out and send them to login rather than into an empty app.
      if (/do not belong to an organization/i.test(message)) {
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
      user: data.user,
      org: membership.org,
      role: membership.role,
      isAdmin: membership.role === "admin",
      // The caller's own row in organization_members. The Team page uses it to
      // recognise "you" and to stop an admin removing themselves.
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
        <AppNav />
        <Outlet />
        <CartDrawer />
        <AddToCartDrawer />
      </div>
    </CartProvider>
  );
}
