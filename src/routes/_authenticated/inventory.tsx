import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import {
  listProducts,
  upsertProduct,
  adjustStock as adjustStockFn,
  togglePin as togglePinFn,
  deleteProduct as deleteProductFn,
  type ProductRow,
} from "@/lib/inventory.functions";
import { InventoryCard, stockStatusOf } from "@/components/inventory/InventoryCard";
import { ProductDrawer } from "@/components/inventory/ProductDrawer";
import AddProductDrawer from "@/components/inventory/AddProductDrawer";
import AddStockDrawer from "@/components/inventory/AddStockDrawer";
import { EmptyInventory, NoResults } from "@/components/inventory/EmptyState";
import { PageHeader } from "@/components/inventory/AppNav";
import { useOrg } from "@/hooks/use-org";
import { useCart } from "@/components/cart/cart-context";
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

type StockFilter = "all" | "in_stock" | "low_stock" | "out_of_stock";
const STATUS_FILTERS: { id: StockFilter; label: string }[] = [
  { id: "all", label: "All status" },
  { id: "in_stock", label: "In Stock" },
  { id: "low_stock", label: "Low Stock" },
  { id: "out_of_stock", label: "Out of Stock" },
];
const PAGE = 8;
const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

function InventoryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  void router;
  void navigate;

  // Admins manage the catalogue; employees read it and sell from it. This only
  // decides what renders — the server functions and RLS enforce the same rule.
  const { isAdmin: canManage } = useOrg();

  const list = useServerFn(listProducts);
  const upsert = useServerFn(upsertProduct);
  const adjust = useServerFn(adjustStockFn);
  const pin = useServerFn(togglePinFn);
  const remove = useServerFn(deleteProductFn);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: () => list(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["products"], refetchType: "active" });

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

  const cart = useCart();

  const addToCart = (p: ProductRow) => {
    if (p.stock <= 0) return;
    cart.openEntry(p); // opens the entry drawer to collect full sale detail
  };

  const [query, setQuery] = useState("");
  const [model, setModel] = useState<string>("all");
  const [status, setStatus] = useState<StockFilter>("all");
  const [visible, setVisible] = useState(PAGE);
  const [openProduct, setOpenProduct] = useState<ProductRow | null>(null);
  const [openAdd, setOpenAdd] = useState(false);
  const [addStockProduct, setAddStockProduct] = useState<ProductRow | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState<ProductRow | null>(null);

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

  const kpis = useMemo(() => {
    const total = products.length;
    const low = products.filter((p) => stockStatusOf(p) === "low_stock").length;
    const out = products.filter((p) => stockStatusOf(p) === "out_of_stock").length;
    const value = products.reduce((s, p) => s + p.stock * Number(p.purchase_price), 0);
    return { total, low, out, value };
  }, [products]);

  const resetFilters = () => {
    setQuery("");
    setModel("all");
    setStatus("all");
  };

  const handleAdd = () => {
    setEditingProduct(null);
    setOpenAdd(true);
  };
  async function handleSaveProduct(payload: any) {
    await upsert({ data: payload });
    invalidate();
  }

  const handleEdit = (p: ProductRow) => {
    setEditingProduct(p);
    setOpenAdd(true);
  };

  const isEmpty = !isLoading && products.length === 0;
  const noResults = !isEmpty && filtered.length === 0 && !isLoading;

  return (
    <>
      <PageHeader
        actions={
          canManage ? (
            <button
              onClick={handleAdd}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition active:scale-95"
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">Add Product</span>
            </button>
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

      <main className="mx-auto max-w-7xl animate-in fade-in slide-in-from-bottom-3 px-4 py-6 duration-500 ease-out sm:px-6 lg:py-10">
        <section className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Kpi label="Total Products" value={kpis.total.toString()} />
          <Kpi label="Low Stock" value={kpis.low.toString()} tone="warning" />
          <Kpi label="Out of Stock" value={kpis.out.toString()} tone="danger" />
          <Kpi label="Inventory Value" value={fmt.format(kpis.value)} />
        </section>

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
            <div
              key={`${status}-${model}`}
              className="grid animate-in fade-in grid-cols-1 gap-4 duration-300 ease-out sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4"
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
                  onAddToCart={addToCart}
                  onEdit={handleEdit}
                  onAddStock={(prod) => setAddStockProduct(prod)}
                  onDelete={(id) => setDeleteId(id)}
                  reserved={cart.reservedQty(p.id)}
                />
              ))}
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
      </main>

      {/* Read-only detail view — employees open this to add to cart. */}
      <ProductDrawer
        product={openProduct}
        open={!!openProduct}
        onOpenChange={(v) => !v && setOpenProduct(null)}
        onAddToCart={addToCart}
        onAddStock={canManage ? (p) => setAddStockProduct(p) : undefined}
      />

      {/* Every product/stock write surface below is admin-only, so for an
          employee it is never mounted at all — not merely hidden. */}
      {canManage && (
        <>
          <AddProductDrawer
            open={openAdd}
            onOpenChange={(v) => {
              if (!v) {
                setOpenAdd(false);
                setEditingProduct(null);
              } else {
                setOpenAdd(true);
              }
            }}
            onSave={handleSaveProduct}
            initialCategories={models}
            initialProduct={editingProduct}
          />
          <AddStockDrawer
            product={addStockProduct}
            open={!!addStockProduct}
            onOpenChange={(v) => !v && setAddStockProduct(null)}
            onAdded={async () => {
              setAddStockProduct(null);
              await invalidate();
            }}
          />

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

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "danger";
}) {
  const valueTone =
    tone === "warning"
      ? "text-warning-foreground"
      : tone === "danger"
        ? "text-danger-foreground"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-xl font-semibold tracking-tight sm:text-2xl tabular-nums ${valueTone}`}
      >
        {value}
      </span>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
  );
}
