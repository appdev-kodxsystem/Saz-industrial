"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Pencil, Trash2, ShoppingCart, Package, User } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sellStockItems } from "@/lib/inventory.functions";
import { supabase } from "@/integrations/supabase/client";
import { supabaseThumb } from "@/lib/img";
import { useCart, type ProductSnapshot } from "./cart-context";
import FileDrop from "@/components/ui/file-drop";

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function CartDrawer() {
  const cart = useCart();
  const qc = useQueryClient();
  const sellItems = useServerFn(sellStockItems);

  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // collective amount received against the whole bill. Empty = fully paid.
  const [received, setReceived] = useState("");

  // reset the payment input whenever the active customer cart changes
  useEffect(() => {
    setReceived("");
  }, [cart.activeCartId]);

  const totals = cart.units.reduce(
    (acc, u) => {
      acc.revenue += u.sellingPrice;
      acc.cost += u.cost;
      return acc;
    },
    { revenue: 0, cost: 0 },
  );
  const profit = totals.revenue - totals.cost;

  // empty input means "paid in full"; otherwise clamp to [0, revenue]
  const net = received.trim() === "" ? totals.revenue : Math.min(Math.max(0, Number(received) || 0), totals.revenue);
  const pending = Math.max(0, totals.revenue - net);
  // typed more than the bill total — flagged, not silently rewritten
  const overpaid = received.trim() !== "" && Number(received) > totals.revenue;

  const hasCustomer = !!cart.customerName.trim() && !!cart.customerContact.trim();
  const canCheckout = cart.units.length > 0 && hasCustomer && !overpaid;

  function onReceiptChange(f: File | null) {
    setReceipt(f);
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptPreview(f && f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
  }

  function editProduct(snap: ProductSnapshot) {
    cart.openEntry(
      {
        id: snap.productId,
        name: snap.name,
        sku: snap.sku,
        image_url: snap.imageUrl,
        purchase_price: snap.purchasePrice,
        selling_price: 0,
        stock: snap.availableStock,
      },
      true,
    );
  }

  async function checkout() {
    if (!canCheckout) {
      if (overpaid) return toast.error(`Amount received can't be more than the sale price (${fmt.format(totals.revenue)})`);
      if (!hasCustomer) return toast.error("Customer name and contact are required");
      return;
    }
    setSubmitting(true);
    try {
      if (receipt) {
        try {
          const safeName = `${Date.now()}_${receipt.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const { error: upErr } = await supabase.storage
            .from("receipts")
            .upload(`receipts/cart/${safeName}`, receipt, { upsert: false });
          if (upErr) {
            console.warn("Receipt upload failed", upErr);
            toast.error("Failed to upload receipt file");
          }
        } catch (e) {
          console.warn("Upload error", e);
        }
      }

      const name = cart.customerName.trim();
      const contact = cart.customerContact.trim();
      // spread the collectively-received amount across units in order: each unit
      // is filled to its selling price until the received amount runs out, so the
      // per-sale pending balances add up to the bill's total pending.
      let remaining = net;
      const items = cart.units.map((u) => {
        const pay = Math.min(remaining, u.sellingPrice);
        remaining -= pay;
        return { stockItemId: u.stockItemId, selling_price: u.sellingPrice, net_payment: pay };
      });
      const { sold } = await sellItems({
        data: { items, customer_name: name, customer_contact: contact },
      });

      cart.completeActiveCart();
      onReceiptChange(null);
      cart.setOpen(false);
      // refetch only what a sale actually changes — not every query in the app
      for (const key of [["products"], ["sale"], ["purchase"], ["ledger"], ["profit-series"], ["pending-payments"]]) {
        qc.invalidateQueries({ queryKey: key, refetchType: "active" });
      }
      toast.success(`Sale recorded for ${name} — ${sold} unit(s), total ${fmt.format(totals.revenue)}`);
    } catch (err: any) {
      toast.error(err?.message || "Checkout failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={cart.isOpen} onOpenChange={cart.setOpen}>
      <SheetContent side="right" className="flex max-h-dvh w-full flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-md">
        <SheetHeader className="shrink-0 space-y-0 border-b border-hairline bg-gradient-to-br from-primary/10 via-surface to-background px-5 py-5 text-left">
          <SheetTitle className="flex items-center gap-2.5 text-base font-semibold">
            <span className="grid size-8 place-items-center rounded-xl bg-primary/15 text-primary">
              <ShoppingCart className="size-4" />
            </span>
            Cart
            {cart.count > 0 && (
              <span className="ml-auto mr-8 rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-sm">
                {cart.count} unit{cart.count === 1 ? "" : "s"}
              </span>
            )}
          </SheetTitle>
        </SheetHeader>

        {cart.count === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <div className="grid size-16 place-items-center rounded-2xl bg-surface ring-1 ring-hairline">
              <ShoppingCart className="size-7 text-muted-foreground/40" strokeWidth={1.25} />
            </div>
            <div>
              <p className="text-sm font-medium">Your cart is empty</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Add products from Inventory to build a sale.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              {/* customer */}
              <div className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
                <div className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {initials(cart.customerName)}
                </div>
                <div className="grid flex-1 grid-cols-1 gap-2">
                  <input
                    type="text"
                    value={cart.customerName}
                    onChange={(e) => cart.setCustomer({ name: e.target.value })}
                    placeholder="Customer name"
                    className="h-9 rounded-lg bg-surface-muted px-3 text-sm font-medium outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                  />
                  <input
                    type="text"
                    value={cart.customerContact}
                    onChange={(e) => cart.setCustomer({ contact: e.target.value })}
                    placeholder="Phone or email"
                    className="h-9 rounded-lg bg-surface-muted px-3 text-xs outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              </div>

              {/* items */}
              <div className="space-y-3">
                {cart.productIds.map((pid) => {
                  const snap = cart.snapshots[pid];
                  if (!snap) return null;
                  const rows = cart.unitsFor(pid);
                  const selling = rows.reduce((s, u) => s + u.sellingPrice, 0);
                  return (
                    <div
                      key={pid}
                      className="group relative overflow-hidden rounded-2xl bg-surface p-3 pl-4 shadow-sm ring-1 ring-hairline transition hover:shadow-md hover:ring-foreground/10"
                    >
                      <span
                        aria-hidden
                        className={`absolute inset-y-3 left-0 w-1 rounded-full ${pending > 0 ? "bg-warning" : "bg-success"}`}
                      />
                      <div className="flex items-start gap-3">
                        <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-surface-muted ring-1 ring-hairline">
                          {snap.imageUrl ? (
                            <img src={supabaseThumb(snap.imageUrl, 96)} alt={snap.name} className="h-full w-full object-cover" />
                          ) : (
                            <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                              <Package className="size-5" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold">{snap.name}</span>
                            <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                              ×{rows.length}
                            </span>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">SKU {snap.sku}</div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                            {rows.map((u) => u.manufactureId).filter(Boolean).join(", ") || "—"}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-base font-bold tabular-nums">{fmt.format(selling)}</div>
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2.5">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {rows.length} unit{rows.length === 1 ? "" : "s"}
                        </span>
                        <div className="flex gap-1">
                          <button
                            onClick={() => editProduct(snap)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                          >
                            <Pencil className="size-3.5" /> Edit
                          </button>
                          <button
                            onClick={() => cart.removeProduct(pid)}
                            aria-label={`Remove ${snap.name}`}
                            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-danger-foreground"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* receipt */}
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Receipt (optional)</h3>
                <FileDrop file={receipt} previewUrl={receiptPreview} onChange={onReceiptChange} accept={"image/*,application/pdf"} />
              </section>
            </div>

            {/* footer */}
            <div className="shrink-0 border-t border-hairline bg-background/95 p-4 backdrop-blur">
              {/* amount received */}
              <div className="mb-3">
                <label htmlFor="cart-received" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Amount received
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">Rs</span>
                  <input
                    id="cart-received"
                    type="number"
                    min={0}
                    max={totals.revenue}
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                    placeholder={`${totals.revenue} (paid in full)`}
                    className={`h-11 w-full rounded-xl bg-surface pl-9 pr-3 text-sm font-medium tabular-nums outline-none ring-1 transition focus:ring-2 ${
                      overpaid ? "ring-danger/50 focus:ring-danger/50" : "ring-hairline focus:ring-primary/40"
                    }`}
                  />
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setReceived("")}
                    className={`rounded-full px-2.5 py-1 font-medium transition ${
                      received.trim() === "" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Paid in full
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceived("0")}
                    className={`rounded-full px-2.5 py-1 font-medium transition ${
                      received.trim() === "0" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Unpaid
                  </button>
                  {overpaid && (
                    <span className="ml-auto font-medium text-danger-foreground">Can't exceed {fmt.format(totals.revenue)}</span>
                  )}
                </div>
              </div>

              <div className="mb-3 space-y-1.5 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
                <Row label={`Revenue · ${cart.count} unit${cart.count === 1 ? "" : "s"}`} value={fmt.format(totals.revenue)} strong />
                <Row label="Pending" value={fmt.format(pending)} tone={pending > 0 ? "danger" : undefined} />
                <div className="mt-1.5 flex items-center justify-between border-t border-hairline pt-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <User className="size-3.5" /> Est. profit
                  </span>
                  <span className={`text-sm font-semibold tabular-nums ${profit >= 0 ? "text-success-foreground" : "text-danger-foreground"}`}>
                    {fmt.format(profit)}
                  </span>
                </div>
              </div>

              {!hasCustomer && (
                <p className="mb-2 text-xs text-danger-foreground">Customer name and contact are required.</p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={cart.clear}
                  disabled={submitting}
                  className="rounded-xl bg-secondary px-4 py-3 text-sm font-medium transition hover:bg-accent disabled:opacity-60"
                >
                  Clear
                </button>
                <button
                  onClick={checkout}
                  disabled={!canCheckout || submitting}
                  className={`flex-1 rounded-xl bg-gradient-to-r from-primary to-primary/85 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition active:scale-[0.99] ${
                    submitting ? "cursor-wait opacity-80" : !canCheckout ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:shadow-primary/30"
                  }`}
                  aria-busy={submitting}
                >
                  {submitting ? "Processing…" : `Record sale — ${fmt.format(totals.revenue)}`}
                </button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "good" | "danger" }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums ${strong ? "text-sm font-semibold" : ""} ${
          tone === "good" ? "font-medium text-success-foreground" : tone === "danger" ? "font-medium text-danger-foreground" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export default CartDrawer;
