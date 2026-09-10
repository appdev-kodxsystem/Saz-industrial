"use client";

import { Boxes, Gift, Layers, PackageX, TrendingUp, TriangleAlert, Wallet } from "lucide-react";
import type { ProductRow } from "@/lib/inventory.functions";
import type { AddonRow } from "@/lib/addons.functions";
import { stockStatusOf } from "./InventoryCard";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});
const count = new Intl.NumberFormat("en-US");

/**
 * What the business is actually holding, in one block.
 *
 * The page used to show four counts and one number labelled "Inventory Value",
 * which was cost-only and machinery-only — so it answered neither "how much
 * stock is there" nor "what is it worth". This separates the two questions that
 * are always asked together:
 *
 *   what is on the shelf — how many products, how many physical units
 *   what it is worth     — at cost, at retail, and the margin between them
 *
 * Add-ons are counted too. They are bought, they sit on a shelf and they tie up
 * money exactly like machinery does; leaving them out understated the holding
 * by however much had been spent on giveaways.
 *
 * Cost and margin are admin-only, the same rule as Purchases and Reports.
 */
export function InventoryOverview({
  products,
  addons,
  canSeeCost,
}: {
  products: ProductRow[];
  addons: AddonRow[];
  canSeeCost: boolean;
}) {
  const units = products.reduce((n, p) => n + p.stock, 0);
  const costValue = products.reduce((n, p) => n + p.stock * Number(p.purchase_price), 0);
  const retailValue = products.reduce((n, p) => n + p.stock * Number(p.selling_price), 0);
  const low = products.filter((p) => stockStatusOf(p) === "low_stock").length;
  const out = products.filter((p) => stockStatusOf(p) === "out_of_stock").length;

  const addonUnits = addons.reduce((n, a) => n + (a.on_hand ?? 0), 0);
  const addonValue = addons.reduce((n, a) => n + (a.on_hand_value ?? 0), 0);

  const totalUnits = units + addonUnits;
  const totalCost = costValue + addonValue;
  // Add-ons are given away, never sold, so they add nothing to retail — but
  // their cost still comes out of the margin they help earn.
  const potentialProfit = retailValue - totalCost;
  const margin = retailValue > 0 ? (potentialProfit / retailValue) * 100 : 0;

  return (
    <section className="@container mb-8 flex flex-col gap-3 sm:gap-4">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @4xl:grid-cols-4 sm:gap-4">
        <Stat
          icon={<Layers className="size-4" />}
          label="Products"
          value={count.format(products.length)}
          hint={`${count.format(addons.length)} add-on${addons.length === 1 ? "" : "s"}`}
        />
        <Stat
          icon={<Boxes className="size-4" />}
          label="Items In Stock"
          value={count.format(totalUnits)}
          hint={
            addonUnits > 0
              ? `${count.format(units)} machinery · ${count.format(addonUnits)} add-on`
              : "physical units on hand"
          }
        />
        {canSeeCost ? (
          <>
            <Stat
              icon={<Wallet className="size-4" />}
              label="Stock Value (cost)"
              value={money.format(totalCost)}
              hint="what it cost to buy in"
            />
            <Stat
              icon={<TrendingUp className="size-4" />}
              label="Retail Value"
              value={money.format(retailValue)}
              hint={`${money.format(potentialProfit)} margin · ${margin.toFixed(1)}%`}
              tone="good"
            />
          </>
        ) : (
          <>
            <Stat
              icon={<TriangleAlert className="size-4" />}
              label="Low Stock"
              value={count.format(low)}
              tone={low > 0 ? "warning" : undefined}
            />
            <Stat
              icon={<PackageX className="size-4" />}
              label="Out Of Stock"
              value={count.format(out)}
              tone={out > 0 ? "danger" : undefined}
            />
          </>
        )}
      </div>

      {/* Second row: the things that need acting on, and the add-on holding.
          Employees already have the shortage counts above, so this is the
          admin's follow-up detail rather than a repeat. */}
      {canSeeCost && (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @4xl:grid-cols-4 sm:gap-4">
          <Mini
            icon={<TriangleAlert className="size-3.5" />}
            label="Low stock"
            value={`${count.format(low)} product${low === 1 ? "" : "s"}`}
            tone={low > 0 ? "warning" : undefined}
          />
          <Mini
            icon={<PackageX className="size-3.5" />}
            label="Out of stock"
            value={`${count.format(out)} product${out === 1 ? "" : "s"}`}
            tone={out > 0 ? "danger" : undefined}
          />
          <Mini
            icon={<Gift className="size-3.5" />}
            label="Add-ons held"
            value={`${count.format(addonUnits)} · ${money.format(addonValue)}`}
          />
          <Mini
            icon={<Wallet className="size-3.5" />}
            label="Avg cost / unit"
            value={money.format(totalUnits ? totalCost / totalUnits : 0)}
          />
        </div>
      )}
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warning" | "danger";
}) {
  const valueTone =
    tone === "good"
      ? "text-success-foreground"
      : tone === "warning"
        ? "text-warning-foreground"
        : tone === "danger"
          ? "text-danger-foreground"
          : "text-foreground";
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
      <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </span>
      <span
        className={`text-xl font-semibold tracking-tight tabular-nums sm:text-2xl ${valueTone}`}
      >
        {value}
      </span>
      {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Mini({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
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
    <div className="flex items-center gap-2.5 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-hairline">
      <span className="shrink-0 text-muted-foreground/70">{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className={`truncate text-sm font-semibold tabular-nums ${valueTone}`}>{value}</p>
      </div>
    </div>
  );
}
