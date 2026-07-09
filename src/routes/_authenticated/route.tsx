import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppNav } from "@/components/inventory/AppNav";
import { Toaster } from "@/components/ui/sonner";
import { CartProvider } from "@/components/cart/cart-context";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { AddToCartDrawer } from "@/components/cart/AddToCartDrawer";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
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
