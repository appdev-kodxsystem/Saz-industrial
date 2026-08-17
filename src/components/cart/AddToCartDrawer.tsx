"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, ChevronDown, Gift, Minus, Plus, Package, User, Tag } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { getAvailableStockItems } from "@/lib/inventory.functions";
import { listAddons, type AddonRow } from "@/lib/addons.functions";
import { supabaseThumb } from "@/lib/img";
import { useCart, type CartAddon, type EntryLine } from "./cart-context";

type Unit = { id: string; manufacture_id: string; purchase_price: number };
type Line = { stockItemId: string; selling_price: string; addons: CartAddon[] };

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});
const NEW = "__new__";
const emptyLine = (price = ""): Line => ({ stockItemId: "", selling_price: price, addons: [] });

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

  const defaultSelling = product
    ? Number(product.selling_price) || Number(product.purchase_price) || 0
    : 0;
  // The product's list price prefills every new line, so the common case —
  // "sell N of these at the usual price" — is zero typing.
  const defaultPrice = defaultSelling > 0 ? String(defaultSelling) : "";

  function initForTarget(tid: string | null) {
    if (!product) return;
    const summary = tid ? cart.carts.find((c) => c.id === tid) : null;
    setName(summary?.customerName ?? "");
    setContact(summary?.customerContact ?? "");

    const existing = cart.unitsForInCart(tid, product.id);
    const prefilled = existing.map((u) => ({
      stockItemId: u.stockItemId,
      selling_price: String(u.sellingPrice),
      addons: u.addons ?? [],
    }));
    const fresh = (): Line => emptyLine(defaultPrice);
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
          (items ?? []).map((u) => ({
            id: String(u.id),
            manufacture_id: u.manufacture_id,
            purchase_price: Number(u.purchase_price) || 0,
          })),
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

  const reservedElsewhere = product
    ? cart.reservedUnitIds(product.id, targetCartId)
    : new Set<string>();
  const reservedKey = Array.from(reservedElsewhere).sort().join(",");
  const available = useMemo(
    () => serverUnits.filter((u) => !reservedElsewhere.has(u.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverUnits, reservedKey],
  );

  // The sell-time add-on picker. Shares the ["addons"] cache with the Add-ons
  // page, so opening this drawer after visiting that page costs nothing.
  const fetchAddons = useServerFn(listAddons);
  const { data: allAddons = [] } = useQuery({
    queryKey: ["addons"],
    queryFn: () => fetchAddons(),
    enabled: open,
  });

  // Retired add-ons stay on the sales they already went out on, but drop out of
  // the picker; so does anything with nothing left on the shelf.
  const sellableAddons = useMemo(
    () => allAddons.filter((a: AddonRow) => a.active && a.on_hand > 0),
    [allAddons],
  );

  useEffect(() => {
    const n = Number(quantity);
    if (!quantity || Number.isNaN(n) || n < 1) return;
    setLines((prev) => {
      if (prev.length === n) return prev;
      const next = prev.slice(0, n);
      while (next.length < n) {
        next.push(emptyLine(defaultPrice));
      }
      return next;
    });
  }, [quantity, defaultPrice]);

  // Fill every line that has no unit on it yet with the next free one, oldest
  // first. Ask for 5 and you get the 5 oldest units already chosen; each line's
  // dropdown then lets you swap any of them for a different unit.
  //
  // This depends on `lines` as well as `available` — it used to watch only
  // `available`, so raising the quantity added blank lines that nothing ever
  // filled. Assignments are idempotent (an unchanged pass returns `prev`), so
  // watching `lines` settles after one extra render rather than looping.
  useEffect(() => {
    if (!available.length) return;
    setLines((prev) => {
      const used = new Set(prev.map((l) => l.stockItemId).filter(Boolean));
      let changed = false;
      const next = prev.map((l) => {
        // A unit that was picked up by another cart while this drawer was open
        // is no longer ours to sell — drop it and take the next free one.
        const stillAvailable = !!l.stockItemId && available.some((a) => a.id === l.stockItemId);
        if (stillAvailable) return l;

        const free = available.find((a) => !used.has(a.id));
        if (free) {
          used.add(free.id);
          changed = true;
          return { ...l, stockItemId: free.id };
        }
        // Nothing left to give this line. Clear a stale id so the line reads as
        // unfilled instead of pointing at a unit someone else is selling.
        if (!l.stockItemId) return l;
        changed = true;
        return { ...l, stockItemId: "" };
      });
      return changed ? next : prev;
    });
  }, [available, lines]);

  if (!product) return null;

  const setLine = (idx: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const optionsFor = (idx: number) => {
    const taken = new Set(
      lines
        .filter((_, i) => i !== idx)
        .map((l) => l.stockItemId)
        .filter(Boolean),
    );
    return available.filter((a) => !taken.has(a.id));
  };

  const numOr0 = (s: string) => (s === "" ? 0 : Math.max(0, Number(s) || 0));
  const qtyNum = Number(quantity);
  const maxQty = available.length || 1;
  const setQty = (n: number) => setQuantity(String(Math.max(1, Math.min(n, maxQty))));
  const notEnoughStock = qtyNum > available.length;
  const dupUnits =
    new Set(lines.map((l) => l.stockItemId).filter(Boolean)).size !==
    lines.filter((l) => l.stockItemId).length;
  const incomplete =
    !quantity ||
    Number.isNaN(qtyNum) ||
    qtyNum < 1 ||
    lines.length !== qtyNum ||
    lines.some((l) => !l.stockItemId || l.selling_price === "") ||
    !name.trim() ||
    !contact.trim();

  // How many of an add-on this drawer may still hand out, given what other open
  // carts have already promised and what the other lines here have taken.
  // `exceptIdx` is the line being edited, so its own quantity isn't counted
  // against itself.
  function addonRemaining(addonId: string, exceptIdx?: number) {
    const onHand = sellableAddons.find((a) => a.id === addonId)?.on_hand ?? 0;
    const elsewhere = cart.reservedAddonQty(addonId, targetCartId);
    const here = lines.reduce((n, l, i) => {
      if (i === exceptIdx) return n;
      return n + (l.addons.find((x) => x.addonId === addonId)?.qty ?? 0);
    }, 0);
    return Math.max(0, onHand - elsewhere - here);
  }

  function setLineAddons(idx: number, addons: CartAddon[]) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, addons } : l)));
  }

  const totals = lines.reduce(
    (acc, l) => {
      const unit = available.find((a) => a.id === l.stockItemId);
      acc.selling += numOr0(l.selling_price);
      acc.cost += unit ? unit.purchase_price : Number(product.purchase_price) || 0;
      // Add-ons never touch revenue — they come off the margin instead.
      acc.addonCost += l.addons.reduce((n, a) => n + a.qty * a.unitCost, 0);
      acc.addonUnits += l.addons.reduce((n, a) => n + a.qty, 0);
      return acc;
    },
    { selling: 0, cost: 0, addonCost: 0, addonUnits: 0 },
  );
  const profit = totals.selling - totals.cost - totals.addonCost;

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
        // free extras riding out with this unit — subtracted from profit at
        // checkout, never added to what the customer pays
        addons: l.addons,
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
      <SheetContent
        side="right"
        className="flex max-h-dvh w-full flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-lg"
      >
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
                <img
                  src={supabaseThumb(product.image_url, 112)}
                  alt={product.name}
                  className="h-full w-full object-cover"
                />
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
              <span className="text-[11px] text-muted-foreground">
                {available.length} available
              </span>
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
                        {c.customerName.trim() || "Unnamed"} · {c.count} unit
                        {c.count === 1 ? "" : "s"}
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
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Quantity
            </h3>
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
                <span className="w-10 text-center text-sm font-semibold tabular-nums">
                  {quantity || 0}
                </span>
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
              <p className="text-xs text-danger-foreground">
                Only {available.length} unit(s) available.
              </p>
            )}
          </section>

          {/* units */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Units{" "}
                <span className="font-normal normal-case tracking-normal">
                  · picked for you, swap any
                </span>
              </h3>
              {lines.length > 1 && lines[0].selling_price !== "" && (
                <button
                  type="button"
                  onClick={() =>
                    setLines((prev) =>
                      prev.map((l) => ({ ...l, selling_price: prev[0].selling_price })),
                    )
                  }
                  className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
                >
                  Use first price for all
                </button>
              )}
            </div>
            <div className="space-y-3">
              {lines.map((line, idx) => {
                const opts = optionsFor(idx);
                const selected = available.find((a) => a.id === line.stockItemId);
                return (
                  <div
                    key={idx}
                    className="space-y-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline"
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <span className="grid size-5 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                          {idx + 1}
                        </span>
                        Unit
                      </span>
                      {selected && (
                        <span className="text-[11px] text-muted-foreground">
                          Cost {fmt.format(selected.purchase_price)}
                        </span>
                      )}
                    </div>

                    <Select
                      value={line.stockItemId || undefined}
                      onValueChange={(v) => setLine(idx, { stockItemId: v })}
                    >
                      <SelectTrigger className="h-10 rounded-xl bg-surface-muted px-3 ring-1 ring-hairline">
                        <SelectValue>
                          {selected
                            ? `${selected.manufacture_id} • ${fmt.format(selected.purchase_price)}`
                            : "Select unit"}
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
                              <span className="mr-2 line-clamp-1 font-medium">
                                {a.manufacture_id}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {fmt.format(a.purchase_price)}
                              </span>
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

                    <UnitAddons
                      catalogue={sellableAddons}
                      chosen={line.addons}
                      remaining={(addonId) => addonRemaining(addonId, idx)}
                      onChange={(next) => setLineAddons(idx, next)}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          {/* summary */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-hairline ring-1 ring-hairline">
            <SummaryCell label="Units" value={String(lines.length)} />
            {/* Revenue is deliberately unaffected by add-ons: they are free. */}
            <SummaryCell label="Revenue" value={fmt.format(totals.selling)} />
            <SummaryCell label="Cost" value={fmt.format(totals.cost)} />
            <SummaryCell
              label={totals.addonUnits ? `Add-ons · ${totals.addonUnits}` : "Add-ons"}
              value={totals.addonCost ? `−${fmt.format(totals.addonCost)}` : "—"}
              tone={totals.addonCost ? "danger" : undefined}
            />
            <SummaryCell
              label="Profit"
              value={fmt.format(profit)}
              tone={profit >= 0 ? "good" : "danger"}
              wide
            />
          </div>
        </div>

        <div className="shrink-0 flex gap-2 border-t border-hairline bg-background/95 p-4 backdrop-blur">
          <button
            onClick={() => cart.closeEntry()}
            className="flex-1 rounded-xl bg-secondary py-3 text-sm font-medium transition hover:bg-accent"
          >
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

function SummaryCell({
  label,
  value,
  tone,
  wide,
}: {
  label: string;
  value: string;
  tone?: "good" | "danger";
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 bg-surface p-3 ${wide ? "col-span-2" : ""}`}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-sm font-semibold tabular-nums ${
          tone === "good"
            ? "text-success-foreground"
            : tone === "danger"
              ? "text-danger-foreground"
              : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Optional free extras for ONE unit.
 *
 * Collapsed by default — most sales have no add-ons, and an always-open picker
 * would put a list of blades and cases between the seller and the price field
 * they actually came here for. The header carries the count so a collapsed
 * section still says what is inside it.
 *
 * Quantities are clamped to what is genuinely still on the shelf: on-hand minus
 * what other open carts have promised minus what the other units in this drawer
 * have already taken. The database refuses an over-draw anyway (the FIFO loop in
 * addon_attach_to_sale raises if stock runs out), but finding that out at
 * checkout instead of here would be a poor way to learn it.
 */
function UnitAddons({
  catalogue,
  chosen,
  remaining,
  onChange,
}: {
  catalogue: AddonRow[];
  chosen: CartAddon[];
  remaining: (addonId: string) => number;
  onChange: (next: CartAddon[]) => void;
}) {
  const [open, setOpen] = useState(chosen.length > 0);

  const add = (a: AddonRow) =>
    onChange([
      ...chosen,
      {
        addonId: a.id,
        name: a.name,
        code: a.code,
        qty: 1,
        unitCost: a.unit_cost,
        listValue: a.list_value,
      },
    ]);

  const setQty = (addonId: string, qty: number) =>
    onChange(chosen.map((c) => (c.addonId === addonId ? { ...c, qty } : c)));

  const drop = (addonId: string) => onChange(chosen.filter((c) => c.addonId !== addonId));

  if (catalogue.length === 0 && chosen.length === 0) return null;

  return (
    <div className="rounded-xl bg-surface-muted ring-1 ring-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <Gift className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Add-ons
        </span>
        <span className="text-[11px] text-muted-foreground/70">optional</span>
        <span className="ml-auto flex items-center gap-2">
          {chosen.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {chosen.reduce((n, c) => n + c.qty, 0)} added
            </span>
          )}
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-hairline p-3">
          {/* Every add-on is a pill: click to add it, click again to take it
              off. A dropdown hid the whole catalogue behind an extra click and
              made "what can I give away" something you had to go looking for —
              at a counter that list should just be visible. */}
          {catalogue.length === 0 ? (
            <p className="px-1 text-[11px] text-muted-foreground">
              No add-ons in stock. Receive some on the Add Stock page.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {catalogue.map((a) => {
                const sel = chosen.find((c) => c.addonId === a.id);
                // remaining() already excludes this unit's own quantity, so the
                // cap is "what's left" plus "what I'm already holding".
                const left = remaining(a.id);
                const max = Math.max(1, left + (sel?.qty ?? 0));
                const soldOut = !sel && left <= 0;

                return (
                  <span
                    key={a.id}
                    className={`inline-flex items-center overflow-hidden rounded-full text-[11px] font-medium ring-1 transition ${
                      sel
                        ? "bg-primary text-primary-foreground ring-transparent"
                        : soldOut
                          ? "bg-surface text-muted-foreground/40 ring-hairline"
                          : "bg-surface text-muted-foreground ring-hairline hover:text-foreground"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => (sel ? drop(a.id) : add(a))}
                      disabled={soldOut}
                      aria-pressed={!!sel}
                      title={
                        soldOut
                          ? `${a.name} — none left in stock`
                          : sel
                            ? `Remove ${a.name}`
                            : `Add ${a.name} — ${left} in stock`
                      }
                      className="inline-flex items-center gap-1.5 py-1.5 pl-2.5 pr-2 disabled:cursor-not-allowed"
                    >
                      {sel ? <Check className="size-3" /> : <Plus className="size-3" />}
                      <span className="max-w-36 truncate">{a.name}</span>
                      {!sel && (
                        <span className="tabular-nums opacity-60">{soldOut ? "0" : left}</span>
                      )}
                    </button>

                    {/* Quantity lives inside the selected pill, as siblings of
                        the toggle rather than nested in it — a button inside a
                        button is invalid, and would swallow these clicks. */}
                    {sel && (
                      <span className="flex items-center bg-primary-foreground/15">
                        <button
                          type="button"
                          onClick={() => setQty(a.id, Math.max(1, sel.qty - 1))}
                          disabled={sel.qty <= 1}
                          aria-label={`One fewer ${a.name}`}
                          className="grid size-6 place-items-center transition hover:bg-primary-foreground/20 disabled:opacity-40"
                        >
                          <Minus className="size-3" />
                        </button>
                        <span className="w-5 text-center tabular-nums">{sel.qty}</span>
                        <button
                          type="button"
                          onClick={() => setQty(a.id, Math.min(max, sel.qty + 1))}
                          disabled={sel.qty >= max}
                          aria-label={`One more ${a.name}`}
                          className="grid size-6 place-items-center transition hover:bg-primary-foreground/20 disabled:opacity-40"
                        >
                          <Plus className="size-3" />
                        </button>
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
            Free for the customer — the price above doesn't change. What they cost you comes off
            this sale's profit.
          </p>
        </div>
      )}
    </div>
  );
}

export default AddToCartDrawer;
