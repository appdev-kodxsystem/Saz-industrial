import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type ProductRow } from "@/lib/inventory.functions";
import { stockStatusOf } from "./InventoryCard";
import { StockBadge } from "./StockBadge";
import { FileText, TrendingUp, History, Package } from "lucide-react";

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "PKR" });

export function ProductDrawer({
  product,
  open,
  onOpenChange,
  onAddToCart,
  onAddStock,
}: {
  product: ProductRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAddToCart: (p: ProductRow) => void;
  onAddStock: (p: ProductRow) => void;
}) {
  if (!product) return null;
  const sell = Number(product.selling_price);
  const buy = Number(product.purchase_price);
  const margin = sell > 0 ? ((sell - buy) / sell) * 100 : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
        <SheetHeader className="border-b border-hairline p-6">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-base font-semibold">Product Detail</SheetTitle>
            <StockBadge status={stockStatusOf(product)} />
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-8 p-6">
          <div className="aspect-[4/3] w-full overflow-hidden rounded-2xl bg-surface-muted ring-1 ring-hairline">
            {product.image_url ? (
              <img src={product.image_url} alt={product.name} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                <Package className="size-16" strokeWidth={1.25} />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xl font-semibold tracking-tight">{product.name}</h2>
              <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
            </div>
            {product.description && (
              <p className="text-sm text-pretty text-muted-foreground">{product.description}</p>
            )}
            <p className="text-xs text-muted-foreground">Model: {product.category}</p>
          </div>

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-hairline ring-1 ring-hairline">
            <Stat label="Stock" value={`${product.stock} units`} />
            <Stat label="Reorder at" value={`${product.reorder_at}`} />
            <Stat label="Purchase" value={fmt.format(buy)} />
            <Stat label="Selling" value={fmt.format(sell)} />
          </div>

          <Section icon={<TrendingUp className="size-4" />} title="Profit">
            <div className="grid grid-cols-2 gap-3">
              <MetricBox label="Margin" value={`${margin.toFixed(1)}%`} />
              <MetricBox label="Per unit" value={fmt.format(sell - buy)} />
            </div>
          </Section>
        </div>

        <div className="sticky bottom-0 border-t border-hairline bg-surface/95 p-4 backdrop-blur">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onAddStock(product)}
              className="flex-1 rounded-xl bg-secondary py-3 text-sm font-medium"
            >
              Add Stock
            </button>
            <button
              type="button"
              disabled={product.stock <= 0}
              onClick={() => onAddToCart(product)}
              className="flex-1 rounded-xl bg-primary py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
            >
              Add to Cart
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface p-4">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-muted p-4">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {icon} {title}
      </h4>
      {children}
    </section>
  );
}
