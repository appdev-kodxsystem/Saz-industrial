"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  Gift,
  Minus,
  Paperclip,
  Plus,
  Receipt,
  SplitSquareHorizontal,
  Trash2,
  User,
  X,
} from "lucide-react";
import { createSale, getAvailableStockItems } from "@/lib/inventory.functions";
import { listAddons } from "@/lib/addons.functions";
import { supabaseThumb } from "@/lib/img";
import { supabase } from "@/integrations/supabase/client";
import { useOrg } from "@/hooks/use-org";
import FileDrop from "@/components/ui/file-drop";
import {
  addonsPerUnit,
  distributePayment,
  lineAddonCost,
  lineTotal,
  num,
  unitPricesOf,
  useTicket,
  type TicketAddon,
  type TicketLine,
} from "./ticket-context";

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});
const money = (n: number) => fmt.format(n || 0);

/**
 * The open ticket, always on screen beside the item picker.
 *
 * Everything the till needs to change about a sale is here and nowhere else:
 * how many units, what each one is priced at (shared or per unit), what is
 * being given away with it, who is buying, and how much they actually paid.
 */
export function PosTicket({
  canSeeCost,
  onCompleted,
}: {
  canSeeCost: boolean;
  onCompleted?: (saleId: string) => void;
}) {
  const t = useTicket();
  const qc = useQueryClient();
  const submit = useServerFn(createSale);
  const { org } = useOrg();
  const [showCustomer, setShowCustomer] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);

  // Object URLs are a leak if they are never revoked, and the preview is
  // replaced every time a different file is picked.
  useEffect(() => {
    if (!t.receipt || !t.receipt.type.startsWith("image/")) {
      setReceiptPreview(null);
      return;
    }
    const url = URL.createObjectURL(t.receipt);
    setReceiptPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [t.receipt]);

  // The till no longer asks what was handed over: every sale rung up here is
  // settled in full. `sales.net_payment` still exists and Pending Payments still
  // reads it — a balance is now recorded from that page, not at checkout.
  const applied = t.total;
  const profit = t.total - t.cost - t.addonCost;

  const priced = t.lines.every((l) => unitPricesOf(l).every((p) => p > 0));

  const sell = useMutation({
    mutationFn: async () => {
      // Prices and payment are resolved to per-unit numbers here, because that
      // is the shape `sales` records — one row per unit, each with its own
      // price and its own share of what was paid.
      const flat: {
        stockItemId: string;
        selling_price: number;
        addons: {
          addonId?: string;
          name?: string;
          qty: number;
          unit_cost?: number;
          list_value?: number;
        }[];
      }[] = [];

      for (const line of t.lines) {
        const prices = unitPricesOf(line);
        const perUnitAddons = addonsPerUnit(line);
        line.units.forEach((u, i) => {
          flat.push({
            stockItemId: u.stockItemId,
            selling_price: prices[i],
            addons: perUnitAddons[i].map((a) =>
              a.addonId
                ? { addonId: a.addonId, qty: a.qty }
                : { name: a.name, qty: a.qty, unit_cost: a.unitCost, list_value: a.listValue },
            ),
          });
        });
      }

      const payments = distributePayment(
        flat.map((f) => f.selling_price),
        applied,
      );

      // Upload first: a sale that claims a receipt it does not have is worse
      // than one with no receipt, so storage has to accept the file before the
      // sale is written. Mirrors the purchase flow.
      let receipt_path: string | null = null;
      if (t.receipt) {
        if (!org?.id) throw new Error("No organization — cannot file a receipt");
        const safe = t.receipt.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        // Org id FIRST: the bucket's INSERT policy checks that leading segment
        // against current_org_id(), so this is what makes the object readable
        // by the rest of the org and nobody else.
        const path = `${org.id}/sale-orders/${crypto.randomUUID()}_${safe}`;
        const { error } = await supabase.storage
          .from("receipts")
          .upload(path, t.receipt, { upsert: false });
        if (error) throw new Error(`Receipt upload failed: ${error.message}`);
        receipt_path = path;
      }

      return submit({
        data: {
          receipt_path,
          items: flat.map((f, i) => ({
            stockItemId: f.stockItemId,
            selling_price: f.selling_price,
            net_payment: payments[i],
            addons: f.addons.length ? f.addons : undefined,
          })),
          customer_name: t.customerName.trim() || null,
          customer_contact: t.customerContact.trim() || null,
          note: t.note.trim() || null,
        },
      });
    },
    onSuccess: (res: any) => {
      for (const key of [
        ["products"],
        ["addons"],
        ["sales"],
        ["pending-payments"],
        ["profit-series"],
        ["purchases"],
      ]) {
        qc.invalidateQueries({ queryKey: key, refetchType: "active" });
      }
      // The add-on step cannot fail the sale — the customer paid for the
      // machine, not the giveaway — so a problem there is surfaced separately.
      if (res?.addonWarning) toast.warning(`Sale recorded, but: ${res.addonWarning}`);
      else toast.success(`Sale recorded — ${money(t.total)}`);
      t.clear();
      setShowCustomer(false);
      setShowReceipt(false);
      if (res?.orderId) onCompleted?.(res.orderId);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not record the sale"),
  });

  function complete() {
    if (!t.lines.length) return toast.error("Add an item to the ticket first");
    if (!priced) return toast.error("Every unit needs a price above zero");
    sell.mutate();
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-hairline">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-hairline bg-gradient-to-br from-primary/10 via-surface to-surface px-4 py-3.5">
        <span className="grid size-8 place-items-center rounded-xl bg-primary/15 text-primary">
          <Receipt className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Current sale</p>
          <p className="text-xs text-muted-foreground">
            {t.unitCount === 0
              ? "Click an item to start"
              : `${t.unitCount} unit${t.unitCount === 1 ? "" : "s"} · ${t.lines.length} item${
                  t.lines.length === 1 ? "" : "s"
                }`}
          </p>
        </div>
        {t.unitCount > 0 && (
          <button
            type="button"
            onClick={t.clear}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-danger/10 hover:text-danger-foreground"
          >
            <Trash2 className="size-3.5" />
            Clear
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {t.lines.length === 0 ? (
          <div className="grid h-full min-h-40 place-items-center px-6 text-center">
            <div>
              <Receipt className="mx-auto mb-3 size-8 text-muted-foreground/40" />
              <p className="text-sm font-medium">The ticket is empty</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Click any item on the left to add it. Set its price, quantity and any add-ons here.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {t.lines.map((line) => (
              <TicketLineCard key={line.productId} line={line} canSeeCost={canSeeCost} />
            ))}
          </ul>
        )}
      </div>

      <footer className="shrink-0 space-y-3 border-t border-hairline bg-background/95 p-3.5 backdrop-blur">
        <button
          type="button"
          onClick={() => setShowCustomer((v) => !v)}
          className="flex w-full items-center gap-2 rounded-xl bg-surface-muted px-3 py-2 text-left text-sm ring-1 ring-hairline transition hover:bg-secondary"
        >
          <User className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {t.customerName.trim() || (
              <span className="text-muted-foreground">Add customer (optional)</span>
            )}
          </span>
          <ChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${showCustomer ? "rotate-180" : ""}`}
          />
        </button>

        <button
          type="button"
          onClick={() => setShowReceipt((v) => !v)}
          className="flex w-full items-center gap-2 rounded-xl bg-surface-muted px-3 py-2 text-left text-sm ring-1 ring-hairline transition hover:bg-secondary"
        >
          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
          {/* A stable label, never the raw filename: "Screenshot 2026-09-07 at
              3.22.34 PM.png" as a heading is unreadable, and the panel below
              already shows the name, size and a thumbnail. */}
          <span className="min-w-0 flex-1 truncate">
            {t.receipt ? (
              "Attachment"
            ) : (
              <span className="text-muted-foreground">Attach image (optional)</span>
            )}
          </span>
          {t.receipt && (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              1 file
            </span>
          )}
          <ChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${showReceipt ? "rotate-180" : ""}`}
          />
        </button>

        {showReceipt && (
          <FileDrop
            file={t.receipt}
            previewUrl={receiptPreview}
            accept="image/*,application/pdf"
            onChange={t.setReceipt}
          />
        )}

        {showCustomer && (
          <div className="space-y-2">
            <input
              value={t.customerName}
              onChange={(e) => t.setCustomer({ name: e.target.value })}
              placeholder="Customer name"
              className="h-9 w-full rounded-lg bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
            />
            <input
              value={t.customerContact}
              onChange={(e) => t.setCustomer({ contact: e.target.value })}
              placeholder="Phone or email"
              className="h-9 w-full rounded-lg bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
            />
            <input
              value={t.note}
              onChange={(e) => t.setCustomer({ note: e.target.value })}
              placeholder="Note (optional)"
              className="h-9 w-full rounded-lg bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
            />
          </div>
        )}

        <div className="space-y-1.5 text-sm">
          <Row label="Subtotal" value={money(t.total)} />
          {canSeeCost && t.addonCost > 0 && (
            <Row label="Add-ons given" value={`−${money(t.addonCost)} margin`} muted />
          )}
          {canSeeCost && t.lines.length > 0 && (
            <Row label="Profit" value={money(profit)} tone={profit >= 0 ? "good" : "danger"} />
          )}
          <div className="flex items-baseline justify-between border-t border-hairline pt-2">
            <span className="text-sm font-semibold">Total</span>
            <span className="text-lg font-semibold tabular-nums">{money(t.total)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={complete}
          disabled={sell.isPending || t.lines.length === 0 || !priced}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground transition active:scale-[0.99] disabled:opacity-40"
        >
          <Check className="size-4" />
          {sell.isPending ? "Recording…" : "Complete sale"}
        </button>
        {t.lines.length > 0 && !priced && (
          <p className="text-center text-xs text-warning-foreground">
            Every unit needs a price above zero.
          </p>
        )}
      </footer>
    </div>
  );
}

function TicketLineCard({ line, canSeeCost }: { line: TicketLine; canSeeCost: boolean }) {
  const t = useTicket();
  const [open, setOpen] = useState(false);
  const total = lineTotal(line);
  const addonCost = lineAddonCost(line);
  const qty = line.units.length;
  const custom = !line.perUnit && num(line.price) !== line.listPrice && line.listPrice > 0;

  // The stepper draws the next unit from the same list the picker does, and
  // shares its cache — so "+" here and a click on the left are the same action.
  const fetchUnits = useServerFn(getAvailableStockItems);
  const { data: available = [] } = useQuery({
    queryKey: ["stock-units", line.productId],
    queryFn: () => fetchUnits({ data: { productId: line.productId } }),
    staleTime: 30_000,
  });

  const addOne = () => {
    const ok = t.addUnit(
      {
        id: line.productId,
        name: line.name,
        sku: line.sku,
        image_url: line.imageUrl,
        selling_price: line.listPrice,
      },
      available as any,
    );
    if (!ok) toast.error(`No more ${line.name} in stock`);
  };

  return (
    <li className="overflow-hidden rounded-xl bg-surface-muted/60 ring-1 ring-hairline">
      <div className="flex items-start gap-2.5 p-2.5">
        <Thumb url={line.imageUrl} name={line.name} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{line.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{line.sku}</p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-lg bg-surface ring-1 ring-hairline">
              <button
                type="button"
                onClick={() => t.removeUnit(line.productId)}
                aria-label="One fewer"
                className="grid size-7 place-items-center rounded-l-lg text-muted-foreground transition hover:bg-secondary"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="min-w-7 text-center text-sm font-medium tabular-nums">{qty}</span>
              <button
                type="button"
                onClick={addOne}
                aria-label="One more"
                className="grid size-7 place-items-center rounded-r-lg text-muted-foreground transition hover:bg-secondary"
              >
                <Plus className="size-3.5" />
              </button>
            </div>

            {!line.perUnit && (
              <div className="inline-flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">@</span>
                <input
                  inputMode="decimal"
                  value={line.price}
                  onChange={(e) => t.patchLine(line.productId, { price: e.target.value })}
                  placeholder="0"
                  className="h-7 w-24 rounded-lg bg-surface px-2 text-right text-sm tabular-nums outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                />
              </div>
            )}

            <button
              type="button"
              onClick={() => t.removeLine(line.productId)}
              aria-label={`Remove ${line.name}`}
              className="ml-auto grid size-7 place-items-center rounded-lg text-muted-foreground transition hover:bg-danger/10 hover:text-danger-foreground"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>

          {/* The list price is a default, not a rule — say so when it has been
              overridden, so a mistyped price is visible before it is committed. */}
          {custom && (
            <p className="mt-1.5 text-[11px] text-warning-foreground">
              Custom price · list {money(line.listPrice)}
            </p>
          )}
        </div>

        <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
          {money(total)}
        </span>
      </div>

      <div className="flex items-center gap-1 border-t border-hairline px-2.5 py-1.5">
        {qty > 1 && (
          <button
            type="button"
            onClick={() => t.togglePerUnit(line.productId)}
            className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
              line.perUnit
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-secondary"
            }`}
          >
            <SplitSquareHorizontal className="size-3" />
            Price per unit
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${
            line.addons.length
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-secondary"
          }`}
        >
          <Gift className="size-3" />
          Add-ons
          {line.addons.length > 0 && ` (${line.addons.reduce((n, a) => n + a.qty, 0)})`}
        </button>
        {canSeeCost && addonCost > 0 && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            −{money(addonCost)} margin
          </span>
        )}
      </div>

      {line.perUnit && (
        <div className="border-t border-hairline bg-surface/60 px-2.5 py-2">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Price each unit
          </p>
          <ul className="flex flex-col gap-1.5">
            {line.units.map((u, i) => (
              <li key={u.uid} className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  #{i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {u.manufactureId}
                </span>
                <input
                  inputMode="decimal"
                  value={u.price}
                  onChange={(e) => t.setUnitPrice(line.productId, u.uid, e.target.value)}
                  placeholder="0"
                  className="h-7 w-24 shrink-0 rounded-lg bg-surface px-2 text-right text-sm tabular-nums outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && <AddonPicker line={line} canSeeCost={canSeeCost} />}
    </li>
  );
}

/**
 * Add-ons for ONE item on the ticket.
 *
 * Two sources, one list: the add-on catalogue (drawn out of real stock, FIFO,
 * by the database) and a one-off typed in here — a length of cable, a part off
 * the bench, something that was never stocked as an add-on. Both cost the org
 * money and both come off this sale's profit; only the custom one has no stock
 * to draw down.
 */
function AddonPicker({ line, canSeeCost }: { line: TicketLine; canSeeCost: boolean }) {
  const t = useTicket();
  const fetchAddons = useServerFn(listAddons);
  const [mode, setMode] = useState<"catalogue" | "custom">("catalogue");
  const [customName, setCustomName] = useState("");
  const [customCost, setCustomCost] = useState("");
  const [customQty, setCustomQty] = useState("1");

  const { data: addons = [] } = useQuery({
    queryKey: ["addons"],
    queryFn: () => fetchAddons(),
  });

  // Only what is actually on the shelf can be given away.
  const sellable = useMemo(() => (addons as any[]).filter((a) => (a.on_hand ?? 0) > 0), [addons]);

  const addCustom = () => {
    const name = customName.trim();
    const qty = Math.max(1, Math.round(num(customQty)));
    if (!name) return toast.error("Give the custom add-on a name");
    t.addAddon(line.productId, {
      name,
      code: "CUSTOM",
      qty,
      unitCost: num(customCost),
      listValue: 0,
      isCustom: true,
    });
    setCustomName("");
    setCustomCost("");
    setCustomQty("1");
  };

  return (
    <div className="space-y-2 border-t border-hairline bg-surface/60 p-2.5">
      {line.addons.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {line.addons.map((a, i) => (
            <li
              key={`${a.addonId ?? a.name}-${i}`}
              className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 ring-1 ring-hairline"
            >
              <Gift className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">
                {a.name}
                {a.isCustom && (
                  <span className="ml-1 rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                    custom
                  </span>
                )}
              </span>
              {canSeeCost && a.unitCost > 0 && (
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {money(a.unitCost)}
                </span>
              )}
              <div className="inline-flex shrink-0 items-center rounded-md bg-surface-muted ring-1 ring-hairline">
                <button
                  type="button"
                  onClick={() => t.setAddonQty(line.productId, i, a.qty - 1)}
                  aria-label="One fewer"
                  className="grid size-6 place-items-center text-muted-foreground transition hover:bg-secondary"
                >
                  <Minus className="size-3" />
                </button>
                <span className="min-w-6 text-center text-xs tabular-nums">{a.qty}</span>
                <button
                  type="button"
                  onClick={() => t.setAddonQty(line.productId, i, a.qty + 1)}
                  aria-label="One more"
                  className="grid size-6 place-items-center text-muted-foreground transition hover:bg-secondary"
                >
                  <Plus className="size-3" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => t.removeAddon(line.productId, i)}
                aria-label={`Remove ${a.name}`}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-danger/10 hover:text-danger-foreground"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1 rounded-lg bg-surface-muted p-0.5 ring-1 ring-hairline">
        {(["catalogue", "custom"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium capitalize transition ${
              mode === m ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            {m === "catalogue" ? "From stock" : "Custom"}
          </button>
        ))}
      </div>

      {mode === "catalogue" ? (
        sellable.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            No add-ons in stock. Buy some in on the Purchases page, or add a custom one.
          </p>
        ) : (
          <div className="max-h-40 overflow-y-auto">
            <ul className="flex flex-col gap-1">
              {sellable.map((a: any) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() =>
                      t.addAddon(line.productId, {
                        addonId: a.id,
                        name: a.name,
                        code: a.code,
                        qty: 1,
                        unitCost: Number(a.unit_cost) || 0,
                        listValue: Number(a.list_value) || 0,
                        isCustom: false,
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-secondary"
                  >
                    <Plus className="size-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs">{a.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {a.on_hand} left
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="What are you throwing in?"
            className="h-8 min-w-0 flex-1 rounded-lg bg-surface px-2 text-xs outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
          />
          <input
            inputMode="decimal"
            value={customCost}
            onChange={(e) => setCustomCost(e.target.value)}
            placeholder="Cost"
            className="h-8 w-20 rounded-lg bg-surface px-2 text-right text-xs tabular-nums outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
          />
          <input
            inputMode="numeric"
            value={customQty}
            onChange={(e) => setCustomQty(e.target.value)}
            placeholder="Qty"
            className="h-8 w-14 rounded-lg bg-surface px-2 text-right text-xs tabular-nums outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={addCustom}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground transition active:scale-95"
          >
            <Plus className="size-3" />
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function Thumb({ url, name }: { url: string | null; name: string }) {
  const src = supabaseThumb(url, 96);
  return src ? (
    <img
      src={src}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-hairline"
    />
  ) : (
    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-xs font-semibold text-muted-foreground">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function Row({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: "good" | "danger";
  muted?: boolean;
}) {
  const cls =
    tone === "good"
      ? "text-success-foreground"
      : tone === "danger"
        ? "text-danger-foreground"
        : muted
          ? "text-muted-foreground"
          : "";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${cls}`}>{value}</span>
    </div>
  );
}
