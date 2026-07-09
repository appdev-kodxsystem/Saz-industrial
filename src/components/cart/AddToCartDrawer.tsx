"use client";

import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Minus, Plus, Package, User, Tag } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { getAvailableStockItems } from "@/lib/inventory.functions";
import { supabaseThumb } from "@/lib/img";
import { useCart, type EntryLine } from "./cart-context";

type Unit = { id: string; manufacture_id: string; purchase_price: number };
type Line = { stockItemId: string; selling_price: string };

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });
const NEW = "__new__";
const emptyLine = (): Line => ({ stockItemId: "", selling_price: "" });

export function AddToCartDrawer() {
  const cart = useCart();
  const product = cart.entryProduct;
  const open = !!product;
  const fetchItems = useServerFn(getAvailableStockItems);

  const [serverUnits, setServerUnits] = useState<Unit[]>([]);
  const [targetCartId, setTargetCartId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");

  const defaultSelling = product ? Number(product.selling_price) || Number(product.purchase_price) || 0 : 0;

  function initForTarget(tid: string | null) {
    if (!product) return;
    const summary = tid ? cart.carts.find((c) => c.id === tid) : null;
    setName(summary?.customerName ?? "");
    setContact(summary?.customerContact ?? "");

    const existing = cart.unitsForInCart(tid, product.id);
    const prefilled = existing.map((u) => ({
      stockItemId: u.stockItemId,
      selling_price: String(u.sellingPrice),
    }));
    const fresh = (): Line => ({
      ...emptyLine(),
      selling_price: "",
    });
    if (existing.length === 0) {
      setQuantity("1");
      setLines([fresh()]);
    } else if (cart.entryMode === "edit") {
      setQuantity(String(existing.length));
      setLines(prefilled);
    } else {
      setQuantity(String(existing.length + 1));
      setLines([...prefilled, fresh()]);
    }
  }

  useEffect(() => {
    if (!product) return;
    const target = cart.activeCartId;
    setTargetCartId(target);
    initForTarget(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  useEffect(() => {
    if (!product || !open) return;
    let cancelled = false;
    (async () => {
      try {
        const items = (await fetchItems({ data: { productId: product.id } })) as Unit[];
        if (cancelled) return;
        setServerUnits(
          (items ?? []).map((u) => ({ id: String(u.id), manufacture_id: u.manufacture_id, purchase_price: Number(u.purchase_price) || 0 })),
        );
      } catch {
        if (!cancelled) setServerUnits([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, open]);

  const reservedElsewhere = product ? cart.reservedUnitIds(product.id, targetCartId) : new Set<string>();
  const reservedKey = Array.from(reservedElsewhere).sort().join(",");
  const available = useMemo(
    () => serverUnits.filter((u) => !reservedElsewhere.has(u.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverUnits, reservedKey],
  );

  useEffect(() => {
    const n = Number(quantity);
    if (!quantity || Number.isNaN(n) || n < 1) return;
    setLines((prev) => {
      if (prev.length === n) return prev;
      const next = prev.slice(0, n);
      while (next.length < n) {
        next.push({ ...emptyLine(), selling_price: "" });
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantity]);

  useEffect(() => {
    if (!available.length) return;
    setLines((prev) => {
      const used = new Set(prev.map((l) => l.stockItemId).filter(Boolean));
      let changed = false;
      const next = prev.map((l) => {
        if (l.stockItemId) return l;
        const free = available.find((a) => !used.has(a.id));
        if (!free) return l;
        used.add(free.id);
        changed = true;
        return { ...l, stockItemId: free.id };
      });
      return changed ? next : prev;
    });
  }, [available]);

  if (!product) return null;

  const setLine = (idx: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const optionsFor = (idx: number) => {
    const taken = new Set(lines.filter((_, i) => i !== idx).map((l) => l.stockItemId).filter(Boolean));
    return available.filter((a) => !taken.has(a.id));
  };

  const numOr0 = (s: string) => (s === "" ? 0 : Math.max(0, Number(s) || 0));
  const qtyNum = Number(quantity);
  const maxQty = available.length || 1;
  const setQty = (n: number) => setQuantity(String(Math.max(1, Math.min(n, maxQty))));
  const notEnoughStock = qtyNum > available.length;
  const dupUnits =
    new Set(lines.map((l) => l.stockItemId).filter(Boolean)).size !== lines.filter((l) => l.stockItemId).length;
  const incomplete =
    !quantity ||
    Number.isNaN(qtyNum) ||
    qtyNum < 1 ||
    lines.length !== qtyNum ||
    lines.some((l) => !l.stockItemId || l.selling_price === "") ||
    !name.trim() ||
    !contact.trim();

  const totals = lines.reduce(
    (acc, l) => {
      const unit = available.find((a) => a.id === l.stockItemId);
      acc.selling += numOr0(l.selling_price);
      acc.cost += unit ? unit.purchase_price : Number(product.purchase_price) || 0;
      return acc;
    },
    { selling: 0, cost: 0 },
  );
  const profit = totals.selling - totals.cost;

  const showCustomerPicker = cart.entryMode === "add" && cart.carts.length > 0;
  const isEdit = cart.entryMode === "edit";

  function onTargetChange(v: string) {
    const tid = v === NEW ? null : v;
    setTargetCartId(tid);
    initForTarget(tid);
  }

  function confirm() {
    if (!product) return;
    if (notEnoughStock) return toast.error(`Only ${available.length} unit(s) available`);
    if (dupUnits) return toast.error("Each line must use a different unit");
    if (incomplete) return toast.error("Fill the customer details and every line");

    const entryLines: EntryLine[] = lines.map((l) => {
      const unit = available.find((a) => a.id === l.stockItemId);
      const selling = numOr0(l.selling_price);
      return {
        stockItemId: l.stockItemId,
        manufactureId: unit?.manufacture_id ?? "",
        cost: unit?.purchase_price ?? (Number(product.purchase_price) || 0),
        sellingPrice: selling,
        // payment is settled collectively at checkout; default to fully paid
        netPayment: selling,
      };
    });

    cart.commitEntry(
      targetCartId,
      { name: name.trim(), contact: contact.trim() },
      {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        imageUrl: product.image_url,
        purchasePrice: Number(product.purchase_price) || 0,
        availableStock: product.stock,
      },
      entryLines,
    );
    toast.success(`${isEdit ? "Updated" : "Added"} ${qtyNum} × ${product.name} for ${name.trim()}`);
    cart.closeEntry();
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && cart.closeEntry()}>
      <SheetContent side="right" className="flex max-h-dvh w-full flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 space-y-0 border-b border-hairline bg-gradient-to-br from-primary/10 via-surface to-background px-5 py-5 text-left">
          <SheetTitle className="flex items-center gap-2.5 text-base font-semibold">
            <span className="grid size-8 place-items-center rounded-xl bg-primary/15 text-primary">
              <Plus className="size-4" />
            </span>
            {isEdit ? "Edit item" : "Add to cart"}
          </SheetTitle>
          <p className="mt-1 pl-[42px] text-xs text-muted-foreground">
            {isEdit ? "Update this line for the customer" : "Set the customer, units and pricing"}
          </p>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {/* product hero */}
          <div className="flex items-center gap-3 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-hairline">
            <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-surface-muted ring-1 ring-hairline">
              {product.image_url ? (
                <img src={supabaseThumb(product.image_url, 112)} alt={product.name} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                  <Package className="size-6" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{product.name}</div>
              <div className="truncate text-xs text-muted-foreground">SKU {product.sku}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Tag className="size-3" /> {fmt.format(defaultSelling)}
              </span>
              <span className="text-[11px] text-muted-foreground">{available.length} available</span>
            </div>
          </div>

          {/* customer */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <User className="size-3.5" /> Customer
            </h3>
            <div className="space-y-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
              {showCustomerPicker && (
                <Select value={targetCartId ?? NEW} onValueChange={onTargetChange}>
                  <SelectTrigger className="h-10 rounded-xl bg-surface-muted px-3 ring-1 ring-hairline">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cart.carts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {(c.customerName.trim() || "Unnamed")} · {c.count} unit{c.count === 1 ? "" : "s"}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW}>+ New customer</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Customer name"
                  className="h-10 rounded-xl bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                />
                <input
                  type="text"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="Phone or email"
                  className="h-10 rounded-xl bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                />
              </div>
            </div>
          </section>

          {/* quantity */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Quantity</h3>
            <div className="flex items-center justify-between rounded-2xl bg-surface p-3 ring-1 ring-hairline">
              <span className="text-sm text-muted-foreground">Units to sell</span>
              <div className="inline-flex items-center rounded-xl bg-surface-muted ring-1 ring-hairline">
                <button
                  onClick={() => setQty(qtyNum - 1)}
                  disabled={qtyNum <= 1}
                  aria-label="Decrease"
                  className="grid size-9 place-items-center rounded-l-xl transition hover:bg-secondary disabled:opacity-40"
                >
                  <Minus className="size-4" />
                </button>
                <span className="w-10 text-center text-sm font-semibold tabular-nums">{quantity || 0}</span>
                <button
                  onClick={() => setQty(qtyNum + 1)}
                  disabled={qtyNum >= maxQty}
                  aria-label="Increase"
                  className="grid size-9 place-items-center rounded-r-xl transition hover:bg-secondary disabled:opacity-40"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            </div>
            {notEnoughStock && (
              <p className="text-xs text-danger-foreground">Only {available.length} unit(s) available.</p>
            )}
          </section>

          {/* units */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Units</h3>
            <div className="space-y-3">
              {lines.map((line, idx) => {
                const opts = optionsFor(idx);
                const selected = available.find((a) => a.id === line.stockItemId);
                return (
                  <div key={idx} className="space-y-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <span className="grid size-5 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                          {idx + 1}
                        </span>
                        Unit
                      </span>
                      {selected && (
                        <span className="text-[11px] text-muted-foreground">Cost {fmt.format(selected.purchase_price)}</span>
                      )}
                    </div>

                    <Select value={line.stockItemId || undefined} onValueChange={(v) => setLine(idx, { stockItemId: v })}>
                      <SelectTrigger className="h-10 rounded-xl bg-surface-muted px-3 ring-1 ring-hairline">
                        <SelectValue>
                          {selected ? `${selected.manufacture_id} • ${fmt.format(selected.purchase_price)}` : "Select unit"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {opts.length === 0 && (
                          <SelectItem value="__empty__" disabled>
                            No units left
                          </SelectItem>
                        )}
                        {opts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            <div className="flex w-full items-center justify-between">
                              <span className="mr-2 line-clamp-1 font-medium">{a.manufacture_id}</span>
                              <span className="text-xs text-muted-foreground">{fmt.format(a.purchase_price)}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">Selling price</span>
                      <input
                        type="number"
                        min={0}
                        placeholder={defaultSelling ? String(defaultSelling) : "Selling price"}
                        value={line.selling_price}
                        onChange={(e) => setLine(idx, { selling_price: e.target.value })}
                        className="h-10 rounded-xl bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </section>

          {/* summary */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-hairline ring-1 ring-hairline">
            <SummaryCell label="Units" value={String(lines.length)} />
            <SummaryCell label="Revenue" value={fmt.format(totals.selling)} />
            <SummaryCell label="Cost" value={fmt.format(totals.cost)} />
            <SummaryCell label="Profit" value={fmt.format(profit)} tone={profit >= 0 ? "good" : "danger"} />
          </div>
        </div>

        <div className="shrink-0 flex gap-2 border-t border-hairline bg-background/95 p-4 backdrop-blur">
          <button onClick={() => cart.closeEntry()} className="flex-1 rounded-xl bg-secondary py-3 text-sm font-medium transition hover:bg-accent">
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={incomplete || dupUnits || notEnoughStock}
            className="flex-[2] rounded-xl bg-gradient-to-r from-primary to-primary/85 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition active:scale-[0.99] hover:shadow-primary/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            {isEdit ? "Save changes" : `Add to cart — ${fmt.format(totals.selling)}`}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SummaryCell({ label, value, tone }: { label: string; value: string; tone?: "good" | "danger" }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface p-3">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-semibold tabular-nums ${
          tone === "good" ? "text-success-foreground" : tone === "danger" ? "text-danger-foreground" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export default AddToCartDrawer;
