import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProductForm } from "@/components/inventory/ProductForm";

export const Route = createFileRoute("/_authenticated/products/new")({
  head: () => ({ meta: [{ title: "Add Product — SAZ Industrial" }] }),
  // Admin-only, same rule as every other product write surface. Hiding the nav
  // link is not enough — an employee can type the URL.
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: NewProductPage,
});

function NewProductPage() {
  return <ProductForm initial={null} />;
}
