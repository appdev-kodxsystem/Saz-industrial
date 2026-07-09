import { Minus, Plus, MoreHorizontal, Pin, ShoppingCart, Eye, Pencil, Trash2, Package } from "lucide-react";
import { StockBadge } from "./StockBadge";
import { type ProductRow } from "@/lib/inventory.functions";
import { supabaseThumb } from "@/lib/img";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function stockStatusOf(p: { stock: number; reorder_at: number }) {
  if (p.stock <= 0) return "out_of_stock" as const;
  if (p.stock <= p.reorder_at) return "low_stock" as const;
  return "in_stock" as const;
}

interface Props {
  product: ProductRow;
  onOpen: (p: ProductRow) => void;
  onAdjust: (id: string, delta: number) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onAddToCart: (p: ProductRow) => void;
  onEdit: (p: ProductRow) => void;
  onAddStock: (p: ProductRow) => void;
  onDelete: (id: string) => void;
  relativeUpdated: string;
  reserved?: number; // units of this product currently held in carts
}

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "PKR" });

export function InventoryCard({
  product,
  onOpen,
  onAdjust,
  onTogglePin,
  onAddToCart,
  onEdit,
  onAddStock,
  onDelete,
  relativeUpdated,
  reserved = 0,
}: Props) {
  const status = stockStatusOf(product);
  const inCart = Math.min(reserved, product.stock);
  const freeToAdd = Math.max(0, product.stock - inCart);
  const stockTone =
    status === "out_of_stock"
      ? "text-danger-foreground"
      : status === "low_stock"
        ? "text-warning-foreground"
        : "text-foreground";

  return (
    <article className="group relative flex flex-col gap-4 rounded-3xl bg-surface p-4 ring-1 ring-hairline transition-all hover:shadow-xl hover:shadow-foreground/5 hover:-translate-y-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(product)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(product);
          }
        }}
        className="relative block overflow-hidden rounded-xl bg-surface-muted text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${product.name}`}
      >
        <div className="aspect-square w-full">
          {product.image_url ? (
            <img
              src={supabaseThumb(product.image_url, 400)}
              alt={product.name}
              loading="lazy"
              decoding="async"
              width={400}
              height={400}
              onError={(e) => {
                // Transform endpoint unavailable → fall back to the original file.
                const img = e.currentTarget;
                if (product.image_url && img.src !== product.image_url) img.src = product.image_url;
              }}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted-foreground/40">
              <Package className="size-12" strokeWidth={1.25} />
            </div>
          )}
        </div>
        <div className="absolute top-2 right-2">
          <StockBadge status={status} />
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(product.id, !product.pinned);
          }}
          aria-label={product.pinned ? "Unpin product" : "Pin product"}
          className={`absolute top-2 left-2 grid size-8 place-items-center rounded-full backdrop-blur ring-1 ring-hairline transition ${
            product.pinned
              ? "bg-foreground text-background"
              : "bg-surface/80 text-muted-foreground opacity-0 group-hover:opacity-100"
          }`}
        >
          <Pin className="size-3.5" />
        </button>

      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-pretty text-sm font-semibold leading-tight">{product.name}</h3>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{product.sku}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Model {product.category} • Updated {relativeUpdated}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 border-y border-hairline py-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Stock</span>
          <div className="flex items-center gap-1.5">
            <span className={`text-sm font-semibold tabular-nums ${stockTone}`}>{product.stock}</span>
            {inCart > 0 && (
              <span className="text-[10px] font-medium text-muted-foreground">({inCart} in cart)</span>
            )}
          </div>
        </div>

      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onAddToCart(product)}
          disabled={freeToAdd <= 0}
          title={freeToAdd <= 0 && product.stock > 0 ? "All units are in a cart" : undefined}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ShoppingCart className="size-3.5" />
          Add to Cart
        </button>
        <button type="button" onClick={() => onOpen(product)} aria-label="View details"
          className="grid size-9 place-items-center rounded-lg bg-secondary text-secondary-foreground hover:bg-accent">
          <Eye className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions"
            className="grid size-9 place-items-center rounded-lg bg-secondary text-secondary-foreground hover:bg-accent"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onEdit(product)}>
              <Pencil className="size-4" /> Edit Product
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAddStock(product)}>
              <Plus className="size-4" /> Add Stock
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onDelete(product.id)} className="text-destructive focus:text-destructive">
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
