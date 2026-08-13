import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Minus,
  Package,
  ListPlus,
  PackagePlus,
  Plus,
  Receipt,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { z } from "zod";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import FileDrop from "@/components/ui/file-drop";
import { supabase } from "@/integrations/supabase/client";
import { supabaseThumb } from "@/lib/img";
import { useOrg } from "@/hooks/use-org";
import { createStockOrder, listProducts, type ProductRow } from "@/lib/inventory.functions";

export const Route = createFileRoute("/_authenticated/stock/new")({
  head: () => ({ meta: [{ title: "Add Stock — SAZ Industrial" }] }),
  // Admin-only: this is stock-in, and it carries purchase cost.
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  validateSearch: z.object({ product: z.string().optional() }),
  component: NewStockOrderPage,
});

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

interface Line {
  productId: string;
  quantity: number;
  /** kept as a string so the field can be emptied while typing */
  price: string;
  /** true = each unit carries its own cost, taken from `unitPrices` */
  perUnit: boolean;
  /** one entry per unit; only meaningful while `perUnit` is true */
  unitPrices: string[];
}

const num = (s: string) => Math.max(0, Number(s) || 0);

/** What every unit on this line costs, in order. */
function unitPricesOf(l: Line): number[] {
  return l.perUnit
    ? l.unitPrices.slice(0, l.quantity).map(num)
    : Array.from({ length: l.quantity }, () => num(l.price));
}

const lineTotal = (l: Line) => unitPricesOf(l).reduce((a, b) => a + b, 0);

/** A line is ready when every price it actually uses has been filled in. */
function lineComplete(l: Line): boolean {
  if (l.quantity < 1) return false;
  return l.perUnit
    ? l.unitPrices.slice(0, l.quantity).every((p) => p.trim() !== "")
    : l.price.trim() !== "";
}

/** Grow/shrink the per-unit price list to match quantity, seeding new units
 *  from the last price entered so a long batch isn't typed out from scratch. */
function fitUnitPrices(l: Line, quantity: number): string[] {
  const seed = l.unitPrices[l.unitPrices.length - 1] ?? l.price;
  const next = l.unitPrices.slice(0, quantity);
  while (next.length < quantity) next.push(seed ?? "");
  return next;
}

/**
 * Stock-in as one order rather than one product at a time: pick a machine, set
 * how many arrived and what they cost, pick the next machine, repeat — then
 * attach the supplier's receipt and commit the lot in a single write.
 *
 * Manufacture ids are NOT collected here. They are generated per product on the
 * server (`<SKU>-0001`, `-0002`, …), which is what removed the longest part of
 * this form.
 */
function NewStockOrderPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { product: preselect } = Route.useSearch();
  const { org } = useOrg();

  const list = useServerFn(listProducts);
  const submitOrder = useServerFn(createStockOrder);
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: () => list(),
  });

  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Arriving from an inventory card's "Add stock" — start the order with that
  // product already on it.
  useEffect(() => {
    if (!preselect || !byId.has(preselect)) return;
    setLines((prev) =>
      prev.some((l) => l.productId === preselect)
        ? prev
        : [...prev, blankLine(byId.get(preselect)!)],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect, products.length]);

  useEffect(() => {
    return () => {
      if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    };
  }, [receiptPreview]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [products, query]);

  const totals = lines.reduce(
    (acc, l) => {
      acc.units += l.quantity;
      acc.cost += lineTotal(l);
      return acc;
    },
    { units: 0, cost: 0 },
  );

  // A product can only appear once on an order — clicking it again just adds
  // another unit, which is what the click almost always means anyway.
  function addProduct(p: ProductRow) {
    setLines((prev) => {
      const at = prev.findIndex((l) => l.productId === p.id);
      if (at === -1) return [...prev, blankLine(p)];
      return prev.map((l, i) => (i === at ? { ...l, quantity: l.quantity + 1 } : l));
    });
    setJustAdded(p.id);
    window.setTimeout(() => setJustAdded((cur) => (cur === p.id ? null : cur)), 900);
  }

  const patchLine = (productId: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));

  // Quantity and the per-unit price list have to move together, or a line ends
  // up with four units and three prices.
  const setQuantity = (productId: string, quantity: number) =>
    setLines((prev) =>
      prev.map((l) =>
        l.productId === productId
          ? { ...l, quantity, unitPrices: l.perUnit ? fitUnitPrices(l, quantity) : l.unitPrices }
          : l,
      ),
    );

  // Switching to per-unit seeds every unit with the single price already typed,
  // so the toggle is a starting point to edit rather than a blank slate.
  const togglePerUnit = (productId: string) =>
    setLines((prev) =>
      prev.map((l) => {
        if (l.productId !== productId) return l;
        if (l.perUnit) {
          // Going back to one price: keep the first unit's price as the shared one.
          return { ...l, perUnit: false, price: l.unitPrices[0] ?? l.price };
        }
        return {
          ...l,
          perUnit: true,
          unitPrices: Array.from({ length: l.quantity }, () => l.price),
        };
      }),
    );

  const setUnitPrice = (productId: string, idx: number, value: string) =>
    setLines((prev) =>
      prev.map((l) =>
        l.productId === productId
          ? { ...l, unitPrices: l.unitPrices.map((p, i) => (i === idx ? value : p)) }
          : l,
      ),
    );

  const removeLine = (productId: string) =>
    setLines((prev) => prev.filter((l) => l.productId !== productId));

  function onReceiptChange(f: File | null) {
    setReceipt(f);
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptPreview(f && f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
  }

  const incomplete = lines.length === 0 || lines.some((l) => !lineComplete(l));

  async function submit() {
    if (lines.length === 0) return toast.error("Add at least one product to the order");
    if (lines.some((l) => !lineComplete(l)))
      return toast.error("Every unit needs a purchase price");

    setSubmitting(true);
    try {
      // Upload the receipt first: if storage rejects it we stop here, rather
      // than writing an order that claims to have a receipt it doesn't have.
      let receipt_path: string | null = null;
      if (receipt) {
        const safe = receipt.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        // The `receipts` bucket's policies only check "is authenticated", not
        // which org an object belongs to, so a guessable path would be readable
        // across tenants. The random segment is what makes it unguessable —
        // the org folder is for humans reading the bucket, not for access.
        const path = `stock-orders/${org.id}/${crypto.randomUUID()}_${safe}`;
        const { error } = await supabase.storage
          .from("receipts")
          .upload(path, receipt, { upsert: false });
        if (error) throw new Error(`Receipt upload failed: ${error.message}`);
        receipt_path = path;
      }

      const res = await submitOrder({
        data: {
          supplier: supplier.trim() || null,
          note: note.trim() || null,
          receipt_path,
          lines: lines.map((l) =>
            l.perUnit
              ? { productId: l.productId, quantity: l.quantity, unit_prices: unitPricesOf(l) }
              : { productId: l.productId, quantity: l.quantity, purchase_price: num(l.price) },
          ),
        },
      });

      for (const key of [["products"], ["purchase"], ["ledger"], ["profit-series"]]) {
        qc.invalidateQueries({ queryKey: key, refetchType: "active" });
      }
      toast.success(`${res.unitCount} unit(s) added — ${fmt.format(res.totalCost)}`);
      navigate({ to: "/purchases" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record the stock order");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Add stock"
        subtitle="Build one order across as many machines as you like"
        actions={
          <button
            onClick={() => navigate({ to: "/inventory" })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium transition hover:bg-accent"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
        }
      />

      <PageBody>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          {/* ---------------- catalogue picker ---------------- */}
          <section className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search machinery by name, SKU or model…"
                className="h-12 w-full rounded-xl bg-surface pl-10 pr-10 text-sm outline-none ring-1 ring-hairline transition focus:ring-2 focus:ring-primary/40"
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

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-[74px] animate-pulse rounded-2xl bg-surface" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-2xl bg-surface p-10 text-center ring-1 ring-hairline">
                <p className="text-sm font-medium">No machinery matches “{query}”</p>
                <button
                  onClick={() => navigate({ to: "/products/new" })}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                >
                  <Plus className="size-4" /> Add it as a product
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((p) => {
                  const line = lines.find((l) => l.productId === p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => addProduct(p)}
                      className={`flex w-full items-center gap-3 rounded-2xl bg-surface p-3 text-left ring-1 transition hover:shadow-md ${
                        justAdded === p.id
                          ? "ring-2 ring-success-foreground/50"
                          : line
                            ? "ring-primary/40"
                            : "ring-hairline hover:ring-foreground/10"
                      }`}
                    >
                      <Thumb url={p.image_url} name={p.name} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{p.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          SKU {p.sku} · {p.category}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[11px] text-muted-foreground">in stock</div>
                        <div className="text-sm font-semibold tabular-nums">{p.stock}</div>
                      </div>
                      <span
                        className={`grid size-8 shrink-0 place-items-center rounded-lg transition ${
                          line
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        {line ? <Check className="size-4" /> : <Plus className="size-4" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* ---------------- the order ---------------- */}
          <section className="lg:sticky lg:top-20 lg:self-start">
            <div className="flex max-h-[calc(100dvh-7rem)] flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-hairline">
              <header className="flex shrink-0 items-center gap-2.5 border-b border-hairline bg-gradient-to-br from-primary/10 via-surface to-surface px-4 py-4">
                <span className="grid size-8 place-items-center rounded-xl bg-primary/15 text-primary">
                  <PackagePlus className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">This order</div>
                  <div className="text-xs text-muted-foreground">
                    {lines.length} product{lines.length === 1 ? "" : "s"} · {totals.units} unit
                    {totals.units === 1 ? "" : "s"}
                  </div>
                </div>
                {lines.length > 0 && (
                  <button
                    onClick={() => setLines([])}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </header>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                {lines.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="grid size-14 place-items-center rounded-2xl bg-surface-muted">
                      <PackagePlus className="size-6 text-muted-foreground/40" strokeWidth={1.25} />
                    </div>
                    <p className="text-sm font-medium">Nothing on this order yet</p>
                    <p className="text-xs text-muted-foreground">
                      Pick machinery on the left to start adding stock.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-3">
                      {lines.map((line) => {
                        const p = byId.get(line.productId);
                        if (!p) return null;
                        const total = lineTotal(line);
                        return (
                          <div
                            key={line.productId}
                            className="rounded-xl bg-surface-muted p-3 ring-1 ring-hairline"
                          >
                            <div className="flex items-start gap-2.5">
                              <Thumb url={p.image_url} name={p.name} size="sm" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold">{p.name}</div>
                                <div className="truncate text-[11px] text-muted-foreground">
                                  SKU {p.sku}
                                </div>
                              </div>
                              <button
                                onClick={() => removeLine(line.productId)}
                                aria-label={`Remove ${p.name}`}
                                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-danger/10 hover:text-danger-foreground"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>

                            <div className="mt-3 flex items-center gap-2">
                              <div className="inline-flex items-center rounded-lg bg-surface ring-1 ring-hairline">
                                <button
                                  onClick={() =>
                                    setQuantity(line.productId, Math.max(1, line.quantity - 1))
                                  }
                                  disabled={line.quantity <= 1}
                                  aria-label="One fewer"
                                  className="grid size-8 place-items-center rounded-l-lg transition hover:bg-secondary disabled:opacity-40"
                                >
                                  <Minus className="size-3.5" />
                                </button>
                                <input
                                  type="number"
                                  min={1}
                                  value={line.quantity}
                                  onChange={(e) =>
                                    setQuantity(
                                      line.productId,
                                      Math.max(1, Math.min(500, Number(e.target.value) || 1)),
                                    )
                                  }
                                  aria-label={`Quantity of ${p.name}`}
                                  className="w-12 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
                                />
                                <button
                                  onClick={() =>
                                    setQuantity(line.productId, Math.min(500, line.quantity + 1))
                                  }
                                  aria-label="One more"
                                  className="grid size-8 place-items-center rounded-r-lg transition hover:bg-secondary"
                                >
                                  <Plus className="size-3.5" />
                                </button>
                              </div>

                              {/* One shared price. Hidden in per-unit mode, where
                                  each unit carries its own below. */}
                              {!line.perUnit && (
                                <div className="relative flex-1">
                                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                                    Rs
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={line.price}
                                    onChange={(e) =>
                                      patchLine(line.productId, { price: e.target.value })
                                    }
                                    placeholder="Cost / unit"
                                    aria-label={`Purchase price per unit of ${p.name}`}
                                    className="h-8 w-full rounded-lg bg-surface pl-8 pr-2 text-sm tabular-nums outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                                  />
                                </div>
                              )}

                              <button
                                type="button"
                                onClick={() => togglePerUnit(line.productId)}
                                aria-pressed={line.perUnit}
                                title={
                                  line.perUnit
                                    ? "Charge every unit the same price"
                                    : "Give each unit its own price"
                                }
                                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium ring-1 transition ${
                                  line.perUnit
                                    ? "bg-primary text-primary-foreground ring-transparent"
                                    : "bg-surface text-muted-foreground ring-hairline hover:text-foreground"
                                } ${line.perUnit ? "ml-auto" : ""}`}
                              >
                                <ListPlus className="size-3.5" />
                                Per-unit
                              </button>
                            </div>

                            {/* Per-unit prices. A batch of the same machine can
                                arrive at different rates, and the cost is stored
                                on the individual stock unit — so the unit that
                                actually gets sold reports what it actually cost. */}
                            {line.perUnit && (
                              <div className="mt-2.5 space-y-1.5 rounded-lg bg-surface p-2.5 ring-1 ring-hairline">
                                {Array.from({ length: line.quantity }, (_, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <span className="w-12 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                      Unit {i + 1}
                                    </span>
                                    <div className="relative flex-1">
                                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                                        Rs
                                      </span>
                                      <input
                                        type="number"
                                        min={0}
                                        value={line.unitPrices[i] ?? ""}
                                        onChange={(e) =>
                                          setUnitPrice(line.productId, i, e.target.value)
                                        }
                                        placeholder="Cost"
                                        aria-label={`Purchase price of ${p.name} unit ${i + 1}`}
                                        className="h-8 w-full rounded-lg bg-surface-muted pl-8 pr-2 text-sm tabular-nums outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                                      />
                                    </div>
                                  </div>
                                ))}
                                <button
                                  type="button"
                                  onClick={() =>
                                    patchLine(line.productId, {
                                      unitPrices: line.unitPrices.map(
                                        () => line.unitPrices[0] ?? "",
                                      ),
                                    })
                                  }
                                  className="w-full rounded-md py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                                >
                                  Copy first price to all
                                </button>
                              </div>
                            )}

                            <div className="mt-2 flex items-center justify-between text-[11px]">
                              <span className="inline-flex items-center gap-1 text-muted-foreground">
                                <Sparkles className="size-3" />
                                IDs {p.sku.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-…
                              </span>
                              <span className="font-semibold tabular-nums">
                                {fmt.format(total)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {/* Supplier, note and receipt are always on screen, empty order
                    or not. Tucked inside the line list they only appeared once
                    something had been added, which read as "there is nowhere to
                    attach the receipt". */}
                <div
                  className={`space-y-3 ${lines.length > 0 ? "border-t border-hairline pt-4" : ""}`}
                >
                  <input
                    value={supplier}
                    onChange={(e) => setSupplier(e.target.value)}
                    placeholder="Supplier (optional)"
                    className="h-10 w-full rounded-xl bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                  />
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Note (optional)"
                    className="h-10 w-full rounded-xl bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline focus:ring-2 focus:ring-primary/40"
                  />
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Receipt className="size-3.5 text-muted-foreground" />
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Order receipt
                      </p>
                      <span className="text-[11px] font-normal normal-case text-muted-foreground/70">
                        photo or PDF
                      </span>
                    </div>
                    <FileDrop
                      file={receipt}
                      previewUrl={receiptPreview}
                      onChange={onReceiptChange}
                      accept="image/*,application/pdf"
                    />
                  </div>
                </div>
              </div>

              <footer className="shrink-0 space-y-3 border-t border-hairline bg-background/95 p-4 backdrop-blur">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {totals.units} unit{totals.units === 1 ? "" : "s"}
                  </span>
                  <span className="text-lg font-bold tabular-nums">{fmt.format(totals.cost)}</span>
                </div>
                <button
                  onClick={submit}
                  disabled={incomplete || submitting}
                  className="w-full rounded-xl bg-gradient-to-r from-primary to-primary/85 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                >
                  {submitting ? "Recording…" : "Record stock order"}
                </button>
                {lines.length > 0 && incomplete && (
                  <p className="text-center text-[11px] text-muted-foreground">
                    Every line needs a purchase price.
                  </p>
                )}
              </footer>
            </div>
          </section>
        </div>
      </PageBody>
    </>
  );
}

function blankLine(p: ProductRow): Line {
  // Seed the cost from what this product last cost, when we know it. Zero means
  // "never bought before" and is left blank so it can't be committed by accident.
  const price = p.purchase_price ? String(p.purchase_price) : "";
  return { productId: p.id, quantity: 1, price, perUnit: false, unitPrices: [price] };
}

function Thumb({
  url,
  name,
  size = "md",
}: {
  url: string | null;
  name: string;
  size?: "sm" | "md";
}) {
  const cls = size === "sm" ? "size-10" : "size-12";
  return (
    <div
      className={`${cls} shrink-0 overflow-hidden rounded-xl bg-surface-muted ring-1 ring-hairline`}
    >
      {url ? (
        <img src={supabaseThumb(url, 96)} alt={name} className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted-foreground/40">
          <Package className="size-5" />
        </div>
      )}
    </div>
  );
}
