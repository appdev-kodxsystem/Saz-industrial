import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listProducts } from "@/lib/inventory.functions";
import { ProductForm } from "@/components/inventory/ProductForm";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";

export const Route = createFileRoute("/_authenticated/products/$productId/edit")({
  head: () => ({ meta: [{ title: "Edit Product — SAZ Industrial" }] }),
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: EditProductPage,
});

function EditProductPage() {
  const { productId } = Route.useParams();
  const navigate = useNavigate();
  const list = useServerFn(listProducts);
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: () => list(),
  });

  const product = products.find((p) => p.id === productId) ?? null;
  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort(),
    [products],
  );

  if (isLoading) {
    return (
      <>
        <PageHeader title="Edit product" />
        <PageBody>
          <div className="h-64 animate-pulse rounded-2xl bg-surface" />
        </PageBody>
      </>
    );
  }

  if (!product) {
    return (
      <>
        <PageHeader title="Product not found" />
        <PageBody className="text-center">
          <p className="text-sm text-muted-foreground">
            That product no longer exists, or it belongs to another organization.
          </p>
          <button
            onClick={() => navigate({ to: "/inventory" })}
            className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
          >
            Back to inventory
          </button>
        </PageBody>
      </>
    );
  }

  // Keyed so switching between products remounts the form with fresh state
  // instead of showing the previous product's edits.
  return <ProductForm key={product.id} initial={product} categories={categories} />;
}
