"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Search, X } from "lucide-react";
import { getAvailableStockItems, listProducts, type ProductRow } from "@/lib/inventory.functions";
import { supabaseThumb } from "@/lib/img";
import { useTicket } from "./ticket-context";

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

/**
 * What you sell from.
 *
 * Deliberately NOT the Inventory page: this is a till, so it shows only what
 * can be sold right now, priced, at a size you can hit quickly — no editing, no
 * cost, no catalogue management. Inventory is where the catalogue is looked
 * after; this is where it is sold.
 */
export function ItemPicker() {
  const t = useTicket();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const fetchUnits = useServerFn(getAvailableStockItems);

  const qc = useQueryClient();
  const list = useServerFn(listProducts);
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: () => list(),
  });

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))).sort(),
    [products],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => (category === "all" ? true : p.category === category))
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q),
      );
  }, [products, query, category]);

  // A till is driven from the keyboard, and a barcode scanner is just a very
  // fast keyboard that ends with Enter. Typing (or scanning) a SKU and pressing
  // Enter rings the item straight onto the ticket and clears the box, ready for
  // the next scan — an exact SKU match wins outright, and a search that has
  // narrowed to a single product counts as unambiguous too.
  async function commitSearch() {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const exact = products.find((p) => p.sku.toLowerCase() === q);
    const target = exact ?? (filtered.length === 1 ? filtered[0] : null);
    if (!target) return;

    if (target.stock - t.qtyFor(target.id) <= 0) {
      toast.error(`No more ${target.name} in stock`);
      return;
    }
    try {
      const units = await qc.fetchQuery({
        queryKey: ["stock-units", target.id],
        queryFn: () => fetchUnits({ data: { productId: target.id } }),
        staleTime: 30_000,
      });
      const ok = t.addUnit(
        {
          id: target.id,
          name: target.name,
          sku: target.sku,
          image_url: target.image_url,
          selling_price: Number(target.selling_price) || 0,
        },
        units as any,
      );
      if (!ok) toast.error(`No more ${target.name} in stock`);
      else setQuery("");
    } catch {
      toast.error("Could not read that item's stock — try again");
    }
  }

  // "/" jumps to the search box from anywhere on the page, the way every till
  // and point-of-sale terminal does, without stealing the key while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* The scan box outranks everything else on this pane — it is how the till
          is actually driven — so it rides along as the grid scrolls instead of
          being left behind at the top of a long catalogue. */}
      <div className="sticky top-[var(--page-header-h,4rem)] z-10 -mt-2 bg-background/85 pb-3 pt-2 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitSearch();
              } else if (e.key === "Escape") {
                setQuery("");
              }
            }}
            placeholder="Scan or search — SKU, name, model…"
            aria-label="Scan or search items to sell"
            className="h-11 w-full rounded-xl bg-surface pl-10 pr-10 text-sm outline-none ring-1 ring-hairline transition focus:ring-2 focus:ring-primary/40"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:bg-secondary"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Say what the keyboard does, once, instead of leaving it to be
            discovered. A scanner ends its input with Enter, so this is also the
            instruction for scanning. */}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
          <kbd className="rounded bg-surface-muted px-1 font-sans ring-1 ring-hairline">/</kbd>
          to search
          <span className="text-muted-foreground/40">·</span>
          <kbd className="rounded bg-surface-muted px-1 font-sans ring-1 ring-hairline">Enter</kbd>
          to add a scanned or exact SKU match
          {query.trim().length > 0 && filtered.length > 0 && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="tabular-nums">
                {filtered.length} match{filtered.length === 1 ? "" : "es"}
              </span>
            </>
          )}
        </p>
      </div>

      {categories.length > 0 && (
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
          <Chip active={category === "all"} onClick={() => setCategory("all")}>
            All
          </Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl bg-surface" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl bg-surface p-10 text-center text-sm text-muted-foreground ring-1 ring-hairline">
          {products.length === 0 ? "Nothing in the catalogue yet." : `Nothing matches “${query}”.`}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {filtered.map((p) => (
            <ItemTile key={p.id} product={p} onTicket={t.qtyFor(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ItemTile({ product, onTicket }: { product: ProductRow; onTicket: number }) {
  const t = useTicket();
  const fetchUnits = useServerFn(getAvailableStockItems);

  // Fetched per product and cached, so the first click on a tile is instant for
  // every click after it. The ticket's own stepper shares this cache.
  const { data: available = [], isFetching } = useQuery({
    queryKey: ["stock-units", product.id],
    queryFn: () => fetchUnits({ data: { productId: product.id } }),
    staleTime: 30_000,
    enabled: product.stock > 0,
  });

  // What is left AFTER what this ticket has already claimed — the number that
  // actually answers "can I sell another one".
  const remaining = Math.max(0, product.stock - onTicket);
  const soldOut = product.stock <= 0;
  const thumb = supabaseThumb(product.image_url, 320);

  const add = () => {
    if (soldOut) return;
    if (isFetching && !available.length) return;
    const ok = t.addUnit(
      {
        id: product.id,
        name: product.name,
        sku: product.sku,
        image_url: product.image_url,
        selling_price: Number(product.selling_price) || 0,
      },
      available as any,
    );
    if (!ok) toast.error(`No more ${product.name} in stock`);
  };

  return (
    <button
      type="button"
      onClick={add}
      disabled={soldOut || remaining === 0}
      className={`group relative flex flex-col overflow-hidden rounded-2xl bg-surface text-left ring-1 transition hover:shadow-md active:scale-[0.98] disabled:opacity-50 disabled:hover:shadow-none ${
        onTicket > 0 ? "ring-2 ring-primary/50" : "ring-hairline hover:ring-foreground/10"
      }`}
    >
      <div className="relative aspect-square w-full bg-surface-muted">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-2xl font-semibold text-muted-foreground/50">
            {product.name.slice(0, 2).toUpperCase()}
          </span>
        )}

        {onTicket > 0 && (
          <span className="absolute right-2 top-2 inline-flex min-w-6 items-center justify-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground">
            <Check className="size-3" />
            {onTicket}
          </span>
        )}

        <span
          className={`absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-medium backdrop-blur ${
            soldOut
              ? "bg-danger/80 text-danger-foreground"
              : remaining === 0
                ? "bg-warning/80 text-warning-foreground"
                : "bg-background/80 text-muted-foreground"
          }`}
        >
          {soldOut ? "Out of stock" : remaining === 0 ? "All on ticket" : `${remaining} left`}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-0.5 p-2.5">
        <span className="truncate text-sm font-medium leading-tight">{product.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">{product.sku}</span>
        <span className="mt-0.5 text-sm font-semibold tabular-nums">
          {fmt.format(Number(product.selling_price) || 0)}
        </span>
      </div>
    </button>
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
