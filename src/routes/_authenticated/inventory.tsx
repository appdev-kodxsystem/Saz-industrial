import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, ShoppingCart, X } from "lucide-react";
import { toast } from "sonner";
import {
  listProducts,
  adjustStock as adjustStockFn,
  togglePin as togglePinFn,
  deleteProduct as deleteProductFn,
  type ProductRow,
} from "@/lib/inventory.functions";
import { InventoryCard, stockStatusOf } from "@/components/inventory/InventoryCard";
import { InventoryOverview } from "@/components/inventory/InventoryOverview";
import { listAddons } from "@/lib/addons.functions";
import { ProductDrawer } from "@/components/inventory/ProductDrawer";
import { EmptyInventory, NoResults } from "@/components/inventory/EmptyState";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { useOrg } from "@/hooks/use-org";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { relativeTime } from "@/lib/relative-time";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/inventory")({
  head: () => ({
    meta: [
      { title: "Inventory — SAZ Industrial" },
      { name: "description", content: "Track stock, sales, and profits in one place." },
    ],
  }),
  component: InventoryPage,
});

const STATUS_FILTERS: { id: StockFilter; label: string }[] = [
  { id: "all", label: "All status" },
  { id: "in_stock", label: "In Stock" },
  { id: "low_stock", label: "Low Stock" },
  { id: "out_of_stock", label: "Out of Stock" },
];
type StockFilter = "all" | "in_stock" | "low_stock" | "out_of_stock";
const PAGE = 8;

function InventoryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Admins manage the catalogue; employees read it and sell from it. This only
  // decides what renders — the server functions and RLS enforce the same rule.
  const { isAdmin: canManage } = useOrg();

  const list = useServerFn(listProducts);
  const adjust = useServerFn(adjustStockFn);
  const pin = useServerFn(togglePinFn);
  const remove = useServerFn(deleteProductFn);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: () => list(),
  });

  // Add-ons are stock too — bought, shelved, and holding money — so the
  // overview counts them. Shares the ["addons"] cache with the Add-ons page and
  // the till, so this costs nothing on a warm app.
  const listAddonsFn = useServerFn(listAddons);
  const { data: addons = [] } = useQuery({
    queryKey: ["addons"],
    queryFn: () => listAddonsFn(),
  });

  // Adjusting or deleting stock changes which units exist, so the till's
  // per-product unit lists expire with the product list — not doing this is
  // how a sold or removed unit ends up offered for sale again.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["products"], refetchType: "active" });
    qc.invalidateQueries({ queryKey: ["stock-units"] });
  };

  const adjustMut = useMutation({
    mutationFn: (v: { id: string; delta: number }) => adjust({ data: v }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const pinMut = useMutation({
    mutationFn: (v: { id: string; pinned: boolean }) => pin({ data: v }),
    onSuccess: invalidate,
  });
  const delMut = useMutation({
    mutationFn: (v: { id: string }) => remove({ data: v }),
    onSuccess: () => {
      invalidate();
      setDeleteId(null);
      toast.success("Product deleted");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const [query, setQuery] = useState("");
  const [model, setModel] = useState<string>("all");
  const [status, setStatus] = useState<StockFilter>("all");
  const [visible, setVisible] = useState(PAGE);
  const [openProduct, setOpenProduct] = useState<ProductRow | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const models = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))).sort(),
    [products],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => (model === "all" ? true : p.category === model))
      .filter((p) => (status === "all" ? true : stockStatusOf(p) === status))
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q),
      );
  }, [products, query, model, status]);

  const shown = filtered.slice(0, visible);

  const resetFilters = () => {
    setQuery("");
    setModel("all");
    setStatus("all");
  };

  // Creating a product, editing one and buying stock in are all full pages now
  // rather than side drawers — they are multi-field jobs, and a purchase spans
  // several products at once, which never fitted in a drawer bound to one.
  const handleAdd = () => navigate({ to: "/products/new" });
  const handleEdit = (p: ProductRow) =>
    navigate({ to: "/products/$productId/edit", params: { productId: p.id } });
  const handleBuyMore = (p?: ProductRow) =>
    navigate({ to: "/purchases/new", search: p ? { product: p.id } : {} });

  const isEmpty = !isLoading && products.length === 0;
  const noResults = !isEmpty && filtered.length === 0 && !isLoading;

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle={`${products.length} product${products.length === 1 ? "" : "s"} · ${products.reduce(
          (n, p) => n + p.stock,
          0,
        )} unit${products.reduce((n, p) => n + p.stock, 0) === 1 ? "" : "s"} on the shelf`}
        actions={
          canManage ? (
            <>
              <button
                onClick={() => handleBuyMore()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-hairline transition hover:bg-accent active:scale-95"
              >
                <ShoppingCart className="size-4" />
                <span className="hidden sm:inline">New Purchase</span>
              </button>
              <button
                onClick={handleAdd}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition active:scale-95"
              >
                <Plus className="size-4" />
                <span className="hidden sm:inline">Add Product</span>
              </button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search products, SKU, model…"
              className="w-full rounded-lg bg-surface py-2.5 pl-9 pr-9 text-sm ring-1 ring-hairline placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-secondary"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as StockFilter)}>
            <SelectTrigger className="h-auto w-full rounded-lg border-0 bg-surface px-3 py-2.5 text-sm shadow-none ring-1 ring-hairline focus:ring-2 focus:ring-ring sm:w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {models.length > 0 && (
          <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
            <Chip active={model === "all"} onClick={() => setModel("all")}>
              All
            </Chip>
            {models.map((c) => (
              <Chip key={c} active={model === c} onClick={() => setModel(c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
      </PageHeader>

      <PageBody>
        <InventoryOverview products={products} addons={addons} canSeeCost={canManage} />

        {isLoading ? (
          <GridSkeleton />
        ) : isEmpty ? (
          // Employees get the empty state without the "Add First Product" CTA —
          // it isn't theirs to act on.
          <EmptyInventory onAdd={canManage ? handleAdd : undefined} />
        ) : noResults ? (
          <NoResults onReset={resetFilters} />
        ) : (
          <>
            <div className="@container">
              <div
                key={`${status}-${model}`}
                className="grid animate-in fade-in grid-cols-1 gap-4 duration-300 ease-out sm:grid-cols-[repeat(auto-fill,minmax(240px,280px))] sm:gap-5"
              >
                {shown.map((p) => (
                  <InventoryCard
                    key={p.id}
                    product={p}
                    canManage={canManage}
                    relativeUpdated={relativeTime(p.updated_at)}
                    onOpen={setOpenProduct}
                    onAdjust={(id, delta) => adjustMut.mutate({ id, delta })}
                    onTogglePin={(id, pinned) => pinMut.mutate({ id, pinned })}
                    onEdit={handleEdit}
                    onDelete={(id) => setDeleteId(id)}
                  />
                ))}
              </div>
            </div>

            {visible < filtered.length && (
              <div className="mt-10 flex justify-center">
                <button
                  onClick={() => setVisible((v) => v + PAGE)}
                  className="rounded-lg bg-surface px-4 py-2 text-sm font-medium ring-1 ring-hairline hover:bg-secondary"
                >
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </PageBody>

      {/* Read-only detail view. Selling happens at the till, on Sales. */}
      <ProductDrawer
        product={openProduct}
        open={!!openProduct}
        onOpenChange={(v) => !v && setOpenProduct(null)}
        onBuyMore={canManage ? handleBuyMore : undefined}
      />

      {/* Deleting a product is admin-only, so for an employee this dialog is
          never mounted at all — not merely hidden. */}
      {canManage && (
        <>
          <ConfirmDialog
            open={!!deleteId}
            onOpenChange={(v) => !v && !delMut.isPending && setDeleteId(null)}
            title="Delete product?"
            description={
              <>
                {(() => {
                  const name = products.find((p) => p.id === deleteId)?.name;
                  return name ? (
                    <>
                      <span className="font-medium text-foreground">{name}</span> and its stock
                      history will be permanently removed. This cannot be undone.
                    </>
                  ) : (
                    "This product and its stock history will be permanently removed. This cannot be undone."
                  );
                })()}
              </>
            }
            confirmText="Delete"
            icon={<Trash2 className="size-6" />}
            loading={delMut.isPending}
            onConfirm={() => deleteId && delMut.mutate({ id: deleteId })}
          />
        </>
      )}
    </>
  );
}

function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(240px,280px))]">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-4 rounded-3xl bg-surface p-4 ring-1 ring-hairline"
          >
            <div className="aspect-square w-full animate-pulse rounded-xl bg-surface-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
