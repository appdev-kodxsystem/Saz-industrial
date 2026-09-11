"use client";

import { Boxes, Gift, Layers, TrendingUp, Wallet } from "lucide-react";
import type { ProductRow } from "@/lib/inventory.functions";
import type { AddonRow } from "@/lib/addons.functions";
import { money } from "@/lib/money";

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
 *   what it is worth     — what it cost to buy in, and what it lists for
 *
 * Eight identical tiles gave all eight numbers the same weight, so none of them
 * read as the answer. This is one panel with a shape instead: the single figure
 * that matters set large, and the supporting counts beside it in a quieter row.
 *
 * Add-ons are counted too. They are bought, they sit on a shelf and they tie up
 * money exactly like machinery does; leaving them out understated the holding
 * by however much had been spent on giveaways. They are given away rather than
 * sold, though, so they carry cost but no retail value — which is why the two
 * figures are left side by side to be compared rather than subtracted into a
 * single "margin" that reads as a loss on a shelf full of giveaways.
 *
 * Cost figures are admin-only, the same rule as Purchases and Reports.
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

  const addonUnits = addons.reduce((n, a) => n + (a.on_hand ?? 0), 0);
  const addonValue = addons.reduce((n, a) => n + (a.on_hand_value ?? 0), 0);

  const totalUnits = units + addonUnits;
  const totalCost = costValue + addonValue;

  return (
    <section className="@container mb-8">
      <div className="overflow-hidden rounded-3xl bg-surface ring-1 ring-hairline">
        <div className="flex flex-col gap-6 p-5 @3xl:flex-row @3xl:items-center @3xl:gap-8 sm:p-6">
          {/* The headline. One number, set big, with the comparison it is always
              read against directly underneath it. */}
          <div className="min-w-0 @3xl:w-[34%] @3xl:shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                {canSeeCost ? <Wallet className="size-4.5" /> : <Boxes className="size-4.5" />}
              </span>
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {canSeeCost ? "Stock value at cost" : "Items in stock"}
              </span>
            </div>
            <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
              {canSeeCost ? money(totalCost) : count.format(totalUnits)}
            </p>
            {canSeeCost ? (
              <p className="mt-2 text-xs text-muted-foreground">
                what every unit on the shelf cost to buy in
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                across {count.format(products.length)} product
                {products.length === 1 ? "" : "s"} on the shelf
              </p>
            )}
          </div>

          {/* The supporting counts. Hairline-separated cells rather than eight
              more boxes: same information, one border instead of four. */}
          <dl className="grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-2xl bg-hairline ring-1 ring-hairline @xl:grid-cols-4">
            <Fact
              icon={<Layers className="size-3.5" />}
              label="Products"
              value={count.format(products.length)}
              hint={`${count.format(addons.length)} add-on${addons.length === 1 ? "" : "s"}`}
            />
            <Fact
              icon={<Boxes className="size-3.5" />}
              label="Units held"
              value={count.format(totalUnits)}
              hint={
                addonUnits > 0
                  ? `${count.format(units)} machinery · ${count.format(addonUnits)} add-on`
                  : "physical units"
              }
            />
            {canSeeCost ? (
              <>
                <Fact
                  icon={<TrendingUp className="size-3.5" />}
                  label="Retail value"
                  value={money(retailValue)}
                  hint="if every unit sells at its list price"
                />
                <Fact
                  icon={<Wallet className="size-3.5" />}
                  label="Avg cost / unit"
                  value={money(totalUnits ? totalCost / totalUnits : 0)}
                  hint="across everything held"
                />
              </>
            ) : (
              <>
                <Fact
                  icon={<Gift className="size-3.5" />}
                  label="Add-ons held"
                  value={count.format(addonUnits)}
                />
                <Fact
                  icon={<Boxes className="size-3.5" />}
                  label="Machinery"
                  value={count.format(units)}
                  hint="sellable units"
                />
              </>
            )}
          </dl>
        </div>
      </div>
    </section>
  );
}

function Fact({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface p-3.5">
      <dt className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </dt>
      <dd className="truncate text-lg font-semibold tracking-tight tabular-nums">{value}</dd>
      {hint && <dd className="truncate text-[11px] text-muted-foreground">{hint}</dd>}
    </div>
  );
}
