import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listProducts } from "@/lib/inventory.functions";
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
  const list = useServerFn(listProducts);
  // Only for the category suggestions. Shares the cache with the Inventory page,
  // so arriving from there costs nothing.
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: () => list() });
  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort(),
    [products],
  );

  return <ProductForm initial={null} categories={categories} />;
}
