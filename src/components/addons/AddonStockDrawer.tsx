"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Gift, PackagePlus } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { listAddonBatches, type AddonRow } from "@/lib/addons.functions";
import { relativeTime } from "@/lib/relative-time";
import { supabaseThumb } from "@/lib/img";

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

/**
 * Stock history for one add-on: every batch received, what it cost, and how much
 * of it is left.
 *
 * Add-ons are consumables bought in bulk, so stock is tracked as batches rather
 * than one row per unit. That is what makes the cost exact without a row per
 * giveaway sticker — a lot bought at a different rate is simply a different
 * batch, and the unit handed to a customer reports what it actually cost.
 *
 * Batch cost is admin-only, so employees get the header (what is on the shelf)
 * without the ledger underneath it.
 */
export function AddonStockDrawer({
  addon,
  open,
  onOpenChange,
  canManage,
}: {
  addon: AddonRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canManage: boolean;
}) {
  const navigate = useNavigate();
  const fetchBatches = useServerFn(listAddonBatches);

  const { data: batches = [], isFetching } = useQuery({
    queryKey: ["addons", "batches", addon?.id],
    queryFn: () => fetchBatches({ data: { addonId: addon!.id } }),
    enabled: open && !!addon?.id && canManage,
  });

  if (!addon) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-hairline p-6">
          <SheetTitle className="text-base font-semibold">Add-on stock</SheetTitle>
        </SheetHeader>

        <div className="flex items-center gap-3 border-b border-hairline p-6">
          <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-surface-muted ring-1 ring-hairline">
            {addon.image_url ? (
              <img
                src={supabaseThumb(addon.image_url, 112)}
                alt={addon.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                <Gift className="size-6" />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">{addon.name}</div>
            <div className="font-mono text-xs text-muted-foreground">{addon.code}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{addon.category}</div>
          </div>
        </div>

        <div className="flex flex-col gap-6 p-6">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl bg-hairline ring-1 ring-hairline">
            <Cell label="On hand" value={String(addon.on_hand)} />
            <Cell label="Received" value={String(addon.received)} />
            <Cell label="Given away" value={String(addon.given_away)} />
          </div>

          {canManage && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Batches
              </span>

              {isFetching && batches.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : batches.length === 0 ? (
                <div className="flex flex-col items-start gap-3 rounded-2xl bg-surface-muted p-4">
                  <p className="text-sm text-muted-foreground">
                    No stock received yet. Add-ons arrive on a stock order, alongside machinery and
                    under the same receipt.
                  </p>
                  <button
                    onClick={() => navigate({ to: "/stock/new" })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                  >
                    <PackagePlus className="size-3.5" /> Receive stock
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {batches.map((b) => {
                    const used = b.quantity - b.remaining;
                    const pct = b.quantity > 0 ? (b.remaining / b.quantity) * 100 : 0;
                    return (
                      <div key={b.id} className="rounded-2xl bg-surface-muted p-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-mono text-xs font-medium">{b.batch_code}</span>
                          <span className="text-xs text-muted-foreground">
                            {relativeTime(b.created_at)}
                          </span>
                        </div>
                        <div className="mt-2 flex items-baseline justify-between gap-3 text-sm">
                          <span className="tabular-nums">
                            {b.remaining}
                            <span className="text-muted-foreground"> / {b.quantity} left</span>
                          </span>
                          <span className="tabular-nums text-muted-foreground">
                            {fmt.format(b.unit_cost)} / unit
                          </span>
                        </div>
                        {/* how much of this lot is still on the shelf */}
                        <div
                          className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline"
                          role="img"
                          aria-label={`${b.remaining} of ${b.quantity} remaining`}
                        >
                          <div
                            className={`h-full rounded-full ${pct > 25 ? "bg-success-foreground" : "bg-warning-foreground"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {used > 0 && (
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {used} given away · {fmt.format(used * b.unit_cost)} off margin
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {canManage && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Totals
              </span>
              <dl className="flex flex-col gap-2 rounded-2xl bg-surface-muted p-4">
                <Row label="Value on hand" value={fmt.format(addon.on_hand_value)} />
                <Row label="Total spend" value={fmt.format(addon.total_spend)} muted />
                <Row
                  label="Off margin so far"
                  value={fmt.format(addon.total_spend - addon.on_hand_value)}
                  muted
                />
              </dl>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface p-3">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`text-sm tabular-nums ${muted ? "text-muted-foreground" : "font-medium"}`}>
        {value}
      </dd>
    </div>
  );
}

export default AddonStockDrawer;
