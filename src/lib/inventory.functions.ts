import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOrgAdmin, requireOrgMember } from "@/integrations/supabase/org-middleware";
import { missingAddonTableMessage } from "@/lib/addons.functions";
import type { Tables } from "@/integrations/supabase/types";

type StockItemRow = Tables<"stock_items">;
type SaleRow = Tables<"sales">;

// Which middleware a handler carries IS its permission model:
//   requireOrgMember — admins and employees. Reads, and the sell path.
//   requireOrgAdmin  — admins only. Anything that creates, edits or deletes a
//                      product or a stock unit.
// RLS enforces the same split independently (see the organizations migration),
// so a mistake here is caught by the database rather than becoming a hole.

export interface ProductRow {
  id: string;
  org_id: string;
  // Audit stamp: which member last wrote the row. Goes NULL if that person is
  // removed from the org — the product belongs to the organization, not them.
  user_id: string | null;
  name: string;
  sku: string;
  image_url: string | null;
  category: string;
  description: string | null;
  stock: number;
  reorder_at: number;
  purchase_price: number;
  selling_price: number;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

const productInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  sku: z.string().min(1).max(80),
  image_url: z.string().url().nullable().optional(),
  category: z.string().min(1).max(80),
  description: z.string().max(2000).nullable().optional(),
  // stock is optional when creating a product; inventory is tracked via stock_items
  stock: z.number().int().min(0).max(1_000_000).optional(),
  reorder_at: z.number().int().min(0).max(1_000_000),
  purchase_price: z.number().min(0).max(1_000_000).optional(),
  selling_price: z.number().min(0).max(1_000_000).optional(),
});

export const listProducts = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("products")
      .select("*")
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as ProductRow[];
    // Employees see the catalogue to sell from it, but not purchase cost — the
    // margin block in ProductDrawer is gated on this too. Blank it out of the
    // payload rather than trusting the UI alone.
    if (context.role !== "admin") {
      return rows.map((r) => ({ ...r, purchase_price: 0 }));
    }
    return rows;
  });

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((data: unknown) => productInput.parse(data))
  .handler(async ({ context, data }) => {
    // org_id is the tenant key; user_id records which admin last wrote the row.
    // The update path is additionally pinned to the caller's org so a guessed id
    // from another tenant matches nothing.
    const payload = { ...data, org_id: context.orgId, user_id: context.userId };
    const { data: row, error } = data.id
      ? await context.supabase
          .from("products")
          .update(payload)
          .eq("id", data.id)
          .eq("org_id", context.orgId)
          .select()
          .single()
      : await context.supabase.from("products").insert(payload).select().single();
    if (error) throw new Error(error.message);
    return row as unknown as ProductRow;
  });

export const adjustStock = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), delta: z.number().int().min(-10000).max(10000) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    await applyStockDelta(context.supabase, data.id, data.delta);
    const { data: row, error } = await context.supabase
      .from("products")
      .select("*")
      .eq("id", data.id)
      .eq("org_id", context.orgId)
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as ProductRow;
  });

export const togglePin = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), pinned: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("products")
      .update({ pinned: data.pinned })
      .eq("id", data.id)
      .eq("org_id", context.orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("products")
      .delete()
      .eq("id", data.id)
      .eq("org_id", context.orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// If `err` is a Postgres "relation does not exist" error for a known table,
// returns an actionable migration hint; otherwise null. Callers keep their own
// fallback so non-table errors propagate exactly as before.
function missingTableMessage(err: unknown, withOriginal = false): string | null {
  const msg = String((err as { message?: unknown })?.message ?? err);
  for (const table of ["stock_items", "sales", "stock_orders", "sale_orders"] as const) {
    if (msg.includes(`Could not find the table 'public.${table}'`)) {
      const base = `Missing DB table '${table}'. Run the migrations (see supabase/migrations) and redeploy or run \`supabase db push\`.`;
      return withOriginal ? `${base}\nOriginal: ${msg}` : base;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manufacture ids
// ---------------------------------------------------------------------------
// These used to be typed in by hand, one per unit, which was both the slowest
// part of stocking in and the only field that could silently collide. They are
// derived now: `<SKU>-0001`, `<SKU>-0002`, … per product.
//
// The next free number is read from the ids already on the product rather than
// from a counter, so it survives deleted units, ids that were entered manually
// before this change, and products whose SKU was renamed.

function mfrPrefix(sku: string | null): string {
  const slug = (sku ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "UNIT";
}

async function nextManufactureIds(
  supabase: any,
  productId: string,
  sku: string | null,
  count: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("stock_items")
    .select("manufacture_id")
    .eq("product_id", productId);
  if (error) throw error;

  const prefix = mfrPrefix(sku);
  const taken = new Set<string>(
    (data ?? []).map((r: { manufacture_id: string }) => r.manufacture_id),
  );

  // Continue from the highest number already issued under this prefix. Ids that
  // don't match the pattern (hand-typed batch numbers) are ignored for the
  // sequence but still counted as taken, so we can never re-issue one.
  let seq = 0;
  for (const id of taken) {
    if (typeof id !== "string" || !id.startsWith(`${prefix}-`)) continue;
    const n = Number(id.slice(prefix.length + 1));
    if (Number.isInteger(n) && n > seq) seq = n;
  }

  const ids: string[] = [];
  while (ids.length < count) {
    seq += 1;
    const candidate = `${prefix}-${String(seq).padStart(4, "0")}`;
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

// Batch codes, issued the same way manufacture ids are: `<CODE>-B0001`, per
// add-on, continuing from the highest number already used.
//
// The addon_batch_defaults trigger can do this too, and still does for anything
// that inserts a batch directly. But it cannot do it for a MULTI-ROW insert: a
// BEFORE INSERT trigger's SELECT runs against the statement's snapshot, so rows
// inserted earlier in the same statement are invisible to it and every row
// computes the same next number — which the unique index on
// (addon_id, batch_code) then rejects. That case became reachable the moment one
// add-on line could split into several batches (per-unit pricing), so the codes
// are allocated here, up front, and passed in explicitly.
function batchPrefix(code: string | null): string {
  const slug = (code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "ADDON";
}

async function nextBatchCodes(
  supabase: any,
  addonId: string,
  code: string | null,
  count: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("addon_stock_batches")
    .select("batch_code")
    .eq("addon_id", addonId);
  if (error) throw error;

  const prefix = batchPrefix(code);
  const taken = new Set<string>((data ?? []).map((r: { batch_code: string }) => r.batch_code));

  // Continue from the highest number already issued under this prefix. Codes
  // that don't match the pattern still count as taken, so one can never be
  // re-issued.
  let seq = 0;
  for (const bc of taken) {
    if (typeof bc !== "string" || !bc.startsWith(`${prefix}-B`)) continue;
    const n = Number(bc.slice(prefix.length + 2));
    if (Number.isInteger(n) && n > seq) seq = n;
  }

  const out: string[] = [];
  while (out.length < count) {
    seq += 1;
    const candidate = `${prefix}-B${String(seq).padStart(4, "0")}`;
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    out.push(candidate);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stock orders — one supplier run, many products, one receipt
// ---------------------------------------------------------------------------
// A line prices its units one of two ways:
//   purchase_price — every unit on the line cost the same (the common case)
//   unit_prices    — one price per unit, for a batch bought at mixed rates
// Exactly one of the two, and unit_prices must line up with quantity, so a line
// can never be ambiguous about what a given unit cost.
const stockOrderLine = z
  .object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(500),
    purchase_price: z.number().min(0).max(1_000_000).optional(),
    unit_prices: z.array(z.number().min(0).max(1_000_000)).min(1).max(500).optional(),
  })
  .refine((l) => (l.purchase_price === undefined) !== (l.unit_prices === undefined), {
    message: "Provide either purchase_price or unit_prices, not both",
  })
  .refine((l) => !l.unit_prices || l.unit_prices.length === l.quantity, {
    message: "unit_prices must have exactly one price per unit",
  });

/** The price of each individual unit on a line, however the line was priced. */
function lineUnitPrices(line: {
  quantity: number;
  purchase_price?: number;
  unit_prices?: number[];
}): number[] {
  return line.unit_prices ?? Array.from({ length: line.quantity }, () => line.purchase_price ?? 0);
}

// An add-on line on the same supplier run. Add-ons are bulk consumables with no
// serial number, so a line is ONE batch — a lot received at one price — rather
// than N unit rows.
//
// Per-unit pricing on the client therefore arrives here already collapsed: a
// line whose units cost 14, 14 and 16 is sent as two entries (qty 2 @ 14, qty 1
// @ 16), because that is what those units genuinely are. The same add-on may
// appear on several entries, which is why the cap below is generous.
const addonOrderLine = z.object({
  addonId: z.string().uuid(),
  quantity: z.number().int().min(1).max(100_000),
  unit_cost: z.number().min(0).max(1_000_000),
});

export const createPurchase = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        supplier: z.string().max(200).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
        // storage path inside the private `receipts` bucket, uploaded by the
        // client before this call. Never a public URL.
        receipt_path: z.string().max(500).nullable().optional(),
        // Either side may be empty — an order can be machines only, add-ons
        // only, or both — but an order with nothing on it is not an order.
        lines: z.array(stockOrderLine).max(50).default([]),
        // Higher than `lines` because one add-on priced per unit expands into
        // one entry per distinct price before it gets here.
        addonLines: z.array(addonOrderLine).max(300).default([]),
      })
      .refine((d) => d.lines.length + d.addonLines.length > 0, {
        message: "An order needs at least one machinery or add-on line",
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const productIds = [...new Set(data.lines.map((l) => l.productId))];

    // Snapshot product info so purchase history survives product deletion. The
    // read is pinned to the caller's org, so a guessed id from another tenant
    // simply isn't found.
    const { data: prods, error: prodErr } = await context.supabase
      .from("products")
      .select("id, name, sku, image_url")
      .in("id", productIds)
      .eq("org_id", context.orgId);
    if (prodErr) throw new Error(prodErr.message);
    const prodById = new Map((prods ?? []).map((p) => [p.id, p]));
    for (const id of productIds) {
      if (!prodById.has(id)) throw new Error("A product in this order no longer exists");
    }

    // Same check for the add-on side. Pinned to the caller's org, so an id
    // guessed from another tenant simply isn't found.
    const addonIds = [...new Set(data.addonLines.map((l) => l.addonId))];
    const addonById = new Map<string, { id: string; name: string; code: string }>();
    if (addonIds.length) {
      const { data: addons, error: addonErr } = await context.supabase
        .from("addons")
        .select("id, name, code")
        .in("id", addonIds)
        .eq("org_id", context.orgId);
      if (addonErr) {
        const hint = missingAddonTableMessage(addonErr);
        throw new Error(hint ?? addonErr.message);
      }
      for (const a of addons ?? []) addonById.set(a.id, a as any);
      for (const id of addonIds) {
        if (!addonById.has(id)) throw new Error("An add-on in this order no longer exists");
      }
    }

    // Resolve every line to a flat list of per-unit prices up front, so the
    // uniform and per-unit cases are indistinguishable from here on.
    const pricesByLine = data.lines.map(lineUnitPrices);
    const unitCount = pricesByLine.reduce((n, p) => n + p.length, 0);
    const totalCost = pricesByLine.reduce((n, p) => n + p.reduce((a, b) => a + b, 0), 0);

    // Kept apart from the machinery totals on purpose: total_cost / unit_count
    // keep their existing machinery-only meaning, so the Purchases page can
    // still answer "what did we spend on machinery" without add-ons quietly
    // inflating the number.
    const addonUnitCount = data.addonLines.reduce((n, l) => n + l.quantity, 0);
    const addonCost = data.addonLines.reduce((n, l) => n + l.quantity * l.unit_cost, 0);

    // Ids are generated per product across the WHOLE order, then handed out to
    // the lines — otherwise two lines for the same product (say, two prices from
    // the same supplier) would each start from the same number and collide.
    const perProduct = new Map<string, number>();
    for (const l of data.lines)
      perProduct.set(l.productId, (perProduct.get(l.productId) ?? 0) + l.quantity);
    const pools = new Map<string, string[]>();
    try {
      await Promise.all(
        [...perProduct].map(async ([pid, n]) => {
          pools.set(
            pid,
            await nextManufactureIds(context.supabase, pid, prodById.get(pid)?.sku ?? null, n),
          );
        }),
      );
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    // 1. the order header
    let orderId: string;
    try {
      const res = await context.supabase
        .from("stock_orders")
        .insert({
          org_id: context.orgId,
          user_id: context.userId,
          supplier: data.supplier?.trim() || null,
          note: data.note?.trim() || null,
          receipt_path: data.receipt_path || null,
          total_cost: totalCost,
          unit_count: unitCount,
          addon_cost: addonCost,
          addon_unit_count: addonUnitCount,
        })
        .select("id")
        .single();
      if (res.error) throw res.error;
      orderId = res.data.id as string;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    // 2. every unit in the order, in one insert
    const rows = data.lines.flatMap((line, i) => {
      const snap = prodById.get(line.productId)!;
      const pool = pools.get(line.productId)!;
      // One row per unit, each carrying its OWN price — a line bought at mixed
      // rates stays accurate per unit, which is what the sale later reads back
      // as the cost of the specific unit sold.
      return pricesByLine[i].map((price) => ({
        product_id: line.productId,
        org_id: context.orgId,
        user_id: context.userId,
        order_id: orderId,
        product_name: snap.name,
        product_sku: snap.sku,
        product_image_url: snap.image_url,
        manufacture_id: pool.shift() as string,
        purchase_price: price,
      }));
    });

    // The header is worthless without the stock it claims to have brought in —
    // don't leave a phantom order (and a phantom total) in the purchase history.
    const abandonOrder = async () => {
      await context.supabase
        .from("stock_orders")
        .delete()
        .eq("id", orderId)
        .eq("org_id", context.orgId);
    };

    let inserted: StockItemRow[] = [];
    if (rows.length) {
      try {
        const res = await context.supabase.from("stock_items").insert(rows).select();
        if (res.error) throw res.error;
        inserted = (res.data ?? []) as StockItemRow[];
      } catch (err: any) {
        await abandonOrder();
        const hint = missingTableMessage(err, true);
        if (hint) throw new Error(hint);
        throw new Error(err?.message || String(err));
      }
    }

    // 3. the add-on batches on this order. One row per line: `remaining` starts
    // at `quantity`, and the batch code (TK-01-B0001, …) is issued by a trigger
    // that locks the catalogue row first, so two admins stocking in the same
    // add-on at the same moment queue up instead of colliding.
    let addonBatches = 0;
    if (data.addonLines.length) {
      // Codes are allocated per add-on across the WHOLE order before anything is
      // written, then handed out to the lines — otherwise two entries for the
      // same add-on (two prices from the same supplier) would each compute the
      // same next number and collide on the unique index. See nextBatchCodes.
      const linesPerAddon = new Map<string, number>();
      for (const l of data.addonLines) {
        linesPerAddon.set(l.addonId, (linesPerAddon.get(l.addonId) ?? 0) + 1);
      }
      const codePools = new Map<string, string[]>();
      try {
        await Promise.all(
          [...linesPerAddon].map(async ([aid, n]) => {
            codePools.set(
              aid,
              await nextBatchCodes(context.supabase, aid, addonById.get(aid)?.code ?? null, n),
            );
          }),
        );
      } catch (err: any) {
        await abandonOrder();
        const hint = missingAddonTableMessage(err);
        throw new Error(hint ?? err?.message ?? String(err));
      }

      const batchRows = data.addonLines.map((l) => {
        const snap = addonById.get(l.addonId)!;
        return {
          addon_id: l.addonId,
          org_id: context.orgId,
          user_id: context.userId,
          order_id: orderId,
          addon_name: snap.name,
          addon_code: snap.code,
          batch_code: codePools.get(l.addonId)!.shift() as string,
          quantity: l.quantity,
          remaining: l.quantity,
          unit_cost: l.unit_cost,
        };
      });
      try {
        const res = await context.supabase
          .from("addon_stock_batches")
          .insert(batchRows)
          .select("id");
        if (res.error) throw res.error;
        addonBatches = (res.data ?? []).length;
      } catch (err: any) {
        // Roll the whole order back, machinery included: a half-recorded order
        // is worse than none, because its totals would be wrong forever.
        if (inserted.length) {
          await context.supabase
            .from("stock_items")
            .delete()
            .in(
              "id",
              inserted.map((it) => it.id),
            );
        }
        await abandonOrder();
        const hint = missingAddonTableMessage(err);
        throw new Error(hint ?? err?.message ?? String(err));
      }
    }

    // 4. bump each product's on-hand count. Distinct products are independent.
    // Add-ons have no such counter — their on-hand is derived from the batches
    // by the addon_stock_levels view, so there is nothing here to keep in step.
    await Promise.all([...perProduct].map(([pid, n]) => applyStockDelta(context.supabase, pid, n)));

    return {
      orderId,
      unitCount: inserted.length,
      totalCost,
      addonUnitCount,
      addonCost,
      addonBatches,
      manufactureIds: inserted.map((it) => it.manufacture_id),
    };
  });

// Build the sale insert payload, deriving pending balance + payment status.
// net_payment defaults to the full selling price (fully paid) when omitted, so
// callers that don't pass payment info keep the original "no pending" behavior.
function buildSaleRow(opts: {
  product_id: string;
  stock_item_id: string | null;
  org_id: string;
  user_id: string;
  product_name: string | null;
  product_sku: string | null;
  product_image_url: string | null;
  selling_price?: number;
  net_payment?: number;
  customer_name?: string | null;
  customer_contact?: string | null;
}) {
  const selling = opts.selling_price ?? 0;
  const net = Math.min(opts.net_payment ?? selling, selling);
  return {
    product_id: opts.product_id,
    stock_item_id: opts.stock_item_id,
    // snapshot so the sale + any pending payment survive product deletion.
    // org_id owns the row; user_id records which member rang up the sale.
    org_id: opts.org_id,
    user_id: opts.user_id,
    product_name: opts.product_name,
    product_sku: opts.product_sku,
    product_image_url: opts.product_image_url,
    selling_price: selling,
    net_payment: net,
    payment_status: selling - net > 0 ? "pending" : "completed",
    customer_name: opts.customer_name ?? null,
    customer_contact: opts.customer_contact ?? null,
  };
}

// Move products.stock by `delta`, clamped at zero, and return the new value.
//
// Two reasons this is an RPC rather than a read-then-update:
//
//   1. Permissions. Selling decrements stock, and employees sell — but they have
//      no UPDATE on products (that is what stops them editing names and prices).
//      apply_stock_delta is SECURITY DEFINER and can touch nothing but `stock`,
//      on a product in the caller's own org.
//   2. Atomicity. `SET stock = stock + delta` in one statement cannot lose an
//      update the way SELECT-then-UPDATE could when two sales land together.
async function applyStockDelta(supabase: any, productId: string, delta: number): Promise<number> {
  const { data, error } = await supabase.rpc("apply_stock_delta", {
    p_product_id: productId,
    p_delta: delta,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

/**
 * sale_id → what the add-ons handed out with that sale cost the organization.
 *
 * This is the number that turns profit from `selling - cost` into
 * `selling - cost - addon_cost`. It is read from the sale_addon_totals view,
 * which only has a row for sales that actually carried add-ons, so the map is
 * small even on a long ledger.
 *
 * A failed read degrades to "no add-ons" rather than breaking the page: on a
 * deploy that has not run the add-on migration yet, every sale correctly has
 * zero add-on cost anyway.
 */
async function addonCostBySale(
  supabase: any,
  orgId: string,
): Promise<Map<string, { cost: number; units: number }>> {
  const map = new Map<string, { cost: number; units: number }>();
  const { data, error } = await supabase
    .from("sale_addon_totals")
    .select("sale_id, addon_cost, addon_units")
    .eq("org_id", orgId);
  if (error) return map;
  for (const r of data ?? []) {
    map.set(r.sale_id as string, {
      cost: Number(r.addon_cost) || 0,
      units: Number(r.addon_units) || 0,
    });
  }
  return map;
}

// Attach the free add-ons chosen at the till to the sale rows just written.
//
// One RPC for the whole ticket rather than one per line: addon_attach_bulk runs
// the lot inside a single transaction, so either every add-on on the sale lands
// or none of them do, and there is no window where half a ticket's giveaways
// have been taken out of stock.
//
// A line with an `addonId` is drawn FIFO out of that add-on's batches. A line
// with a `name` is a one-off typed in at the till — no catalogue row, no batch,
// but it still cost the org money and still comes off this sale's profit.
//
// A failure here does NOT fail the sale. The sale is already recorded and is
// complete on its own terms — the customer paid for the machine, not for the
// giveaway. Throwing would tell the till that a sale which actually happened had
// failed, which is the worse error. The caller gets `addonWarning` to show.
async function attachSaleAddons(
  supabase: any,
  items: {
    stockItemId: string;
    addons?: {
      addonId?: string;
      name?: string;
      qty: number;
      unit_cost?: number;
      list_value?: number;
    }[];
  }[],
  sales: SaleRow[],
): Promise<{ addonCost: number; addonWarning: string | null }> {
  const saleByStockItem = new Map<string, string>();
  for (const s of sales) {
    if (s.stock_item_id) saleByStockItem.set(s.stock_item_id, s.id);
  }

  const lines: Record<string, unknown>[] = [];
  for (const it of items) {
    if (!it.addons?.length) continue;
    const saleId = saleByStockItem.get(it.stockItemId);
    if (!saleId) continue;
    for (const a of it.addons) {
      lines.push(
        a.addonId
          ? { sale_id: saleId, addon_id: a.addonId, qty: a.qty }
          : {
              sale_id: saleId,
              name: a.name,
              qty: a.qty,
              unit_cost: a.unit_cost ?? 0,
              list_value: a.list_value ?? 0,
            },
      );
    }
  }
  if (!lines.length) return { addonCost: 0, addonWarning: null };

  const { data, error } = await supabase.rpc("addon_attach_bulk", { p_lines: lines });
  if (error) {
    return {
      addonCost: 0,
      addonWarning: missingAddonTableMessage(error) ?? error.message,
    };
  }
  return { addonCost: Number(data) || 0, addonWarning: null };
}

export interface ProfitSaleRow {
  created_at: string;
  selling_price: number;
  cost: number;
  profit: number;
  /** Snapshot taken at the time of sale, so a renamed or deleted product still
   *  reports under the name it was sold as. */
  product_name: string;
}

export interface LedgerEntry {
  id: string;
  kind: "purchase" | "sale";
  date: string;
  product_id: string;
  product_name: string;
  sku: string;
  // purchase: manufacture/batch id of the stock item. sale: source stock item id.
  reference: string;
  amount: number; // purchase: purchase_price. sale: selling_price.
  cost: number; // sale only: cost of the sold unit (0 for purchase rows).
  profit: number; // sale only, NET of any add-ons given away with it.
  sold: boolean; // purchase rows: whether that stock unit has since been sold.
  // purchase rows only: the stock order this unit arrived on, and the storage
  // path of that order's receipt photo (private bucket — sign it to display).
  order_id?: string | null;
  receipt_path?: string | null;
  // sale rows: what the add-ons handed over with this unit cost the org. Already
  // subtracted from `profit` — carried separately so the ledger can show it.
  addon_cost?: number;
  addon_units?: number;
  // purchase rows: which stream the row came from. Machinery is one row per
  // unit (stock_items); an add-on row is one batch (addon_stock_batches).
  stream?: "machinery" | "addon";
  quantity?: number;
}

// Unified activity ledger. Stock-in/purchase rows come from stock_items,
// stock-out/sale rows from sales. Each row carries its product name + sku.
// Admin-only: it exposes per-unit cost and profit, and it backs the printable
// report, which is an admin surface.
export const getLedger = createServerFn({ method: "GET" })
  .middleware([requireOrgAdmin])
  .handler(async ({ context }): Promise<LedgerEntry[]> => {
    type StockItemSel = Pick<
      StockItemRow,
      | "id"
      | "product_id"
      | "user_id"
      | "product_name"
      | "product_sku"
      | "manufacture_id"
      | "purchase_price"
      | "sold"
      | "created_at"
    >;
    type SaleLedgerSel = Pick<
      SaleRow,
      | "id"
      | "product_id"
      | "user_id"
      | "product_name"
      | "product_sku"
      | "stock_item_id"
      | "selling_price"
      | "created_at"
    >;

    // products, stock_items and sales are independent reads — fire them together
    // so we pay one round trip of latency instead of three.
    const [prodRes, stockRes, salesRes, addonBySale] = await Promise.all([
      context.supabase.from("products").select("id, name, sku"),
      context.supabase
        .from("stock_items")
        .select(
          "id, product_id, user_id, product_name, product_sku, manufacture_id, purchase_price, sold, created_at",
        )
        .eq("org_id", context.orgId),
      context.supabase
        .from("sales")
        .select(
          "id, product_id, user_id, product_name, product_sku, stock_item_id, selling_price, created_at",
        )
        .eq("org_id", context.orgId),
      addonCostBySale(context.supabase, context.orgId),
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    const prodById = new Map<string, { name: string; sku: string }>();
    for (const p of prodRes.data ?? []) prodById.set(p.id, { name: p.name, sku: p.sku });

    const entries: LedgerEntry[] = [];

    // No ownership filter here any more. The queries above are already pinned to
    // context.orgId, and RLS pins them again — so every row that comes back is
    // the org's by construction. The old check compared each row's user_id to the
    // caller's, which under org scoping would hide a teammate's purchases and
    // sales from the shared ledger.

    // Stock-in / purchases
    let stockItems: StockItemSel[] = [];
    if (stockRes.error) {
      if (
        !String(stockRes.error.message).includes("Could not find the table 'public.stock_items'")
      ) {
        throw new Error(stockRes.error.message);
      }
    } else {
      stockItems = (stockRes.data ?? []) as StockItemSel[];
    }
    for (const it of stockItems) {
      const p = it.product_id ? prodById.get(it.product_id) : undefined;
      entries.push({
        id: it.id,
        kind: "purchase",
        date: it.created_at,
        // product_id may be null after deletion; snapshot keeps history intact
        product_id: it.product_id ?? "",
        product_name: p?.name ?? it.product_name ?? "Deleted product",
        sku: p?.sku ?? it.product_sku ?? "—",
        reference: it.manufacture_id ?? "—",
        amount: Number(it.purchase_price) || 0,
        cost: 0,
        profit: 0,
        sold: Boolean(it.sold),
      });
    }

    // Stock-out / sales
    const costById = new Map<string, number>();
    for (const it of stockItems) costById.set(it.id, Number(it.purchase_price) || 0);

    let sales: SaleLedgerSel[] = [];
    if (salesRes.error) {
      if (!String(salesRes.error.message).includes("Could not find the table 'public.sales'")) {
        throw new Error(salesRes.error.message);
      }
    } else {
      sales = (salesRes.data ?? []) as SaleLedgerSel[];
    }
    for (const s of sales) {
      const p = s.product_id ? prodById.get(s.product_id) : undefined;
      const selling = Number(s.selling_price) || 0;
      const cost = s.stock_item_id ? (costById.get(s.stock_item_id) ?? 0) : 0;
      const addon = addonBySale.get(s.id);
      const addonCost = addon?.cost ?? 0;
      entries.push({
        id: s.id,
        kind: "sale",
        date: s.created_at,
        // product_id may be null once the product is deleted; sale row + its
        // snapshot name/sku are preserved so history stays intact.
        product_id: s.product_id ?? "",
        product_name: p?.name ?? s.product_name ?? "Deleted product",
        sku: p?.sku ?? s.product_sku ?? "—",
        reference: s.stock_item_id ?? "—",
        amount: selling,
        cost,
        profit: selling - cost - addonCost,
        sold: true,
        addon_cost: addonCost,
        addon_units: addon?.units ?? 0,
      });
    }

    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return entries;
  });

// Returns every sale joined with its stock item's purchase price, so the client
// can bucket profit/revenue by week/month/year. Admin-only: it is nothing but
// cost and profit, and it backs the admin Reports page.
export const getProfitSeries = createServerFn({ method: "GET" })
  .middleware([requireOrgAdmin])
  // Bounds are optional and default to "all time", so a caller that wants the
  // whole history still just calls it with nothing. Reports narrows them when a
  // custom range is picked, which keeps a long history off the wire.
  .inputValidator((d: unknown) =>
    z
      .object({
        from: z.number().min(0).optional().default(0),
        to: z.number().min(0).optional().default(0),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ context, data }): Promise<ProfitSaleRow[]> => {
    const { fromIso, toIso } = rangeIso(data.from, data.to);
    let sq = context.supabase
      .from("sales")
      .select("id, selling_price, created_at, stock_item_id, product_name")
      .eq("org_id", context.orgId);
    if (fromIso) sq = sq.gte("created_at", fromIso);
    if (toIso) sq = sq.lte("created_at", toIso);
    sq = sq.order("created_at", { ascending: true });

    // sales, cost map and add-on totals are independent — fetch in parallel
    const [salesRes, costRes, addonBySale] = await Promise.all([
      sq,
      context.supabase.from("stock_items").select("id, purchase_price").eq("org_id", context.orgId),
      addonCostBySale(context.supabase, context.orgId),
    ]);

    let sales: {
      id: string;
      selling_price: number;
      created_at: string;
      stock_item_id: string | null;
      product_name: string | null;
    }[] = [];
    if (salesRes.error) {
      if (String(salesRes.error.message).includes("Could not find the table 'public.sales'"))
        return [];
      throw new Error(salesRes.error.message);
    }
    sales = (salesRes.data ?? []) as typeof sales;

    // Map stock_item_id -> purchase_price for cost/profit. stock_items missing -> cost 0.
    const costById = new Map<string, number>();
    if (!costRes.error) {
      for (const row of costRes.data ?? []) costById.set(row.id, Number(row.purchase_price) || 0);
    }

    // Profit is net of the add-ons given away with each sale, so every chart on
    // Reports agrees with the Sales ledger instead of running slightly rich.
    return sales.map((s) => {
      const cost = s.stock_item_id ? (costById.get(s.stock_item_id) ?? 0) : 0;
      const addon = addonBySale.get(s.id)?.cost ?? 0;
      const selling = Number(s.selling_price) || 0;
      return {
        created_at: s.created_at,
        selling_price: selling,
        cost: cost + addon,
        profit: selling - cost - addon,
        product_name: s.product_name ?? "Unnamed product",
      };
    });
  });

export const getAvailableStockItems = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object({ productId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    try {
      // The cart drawer projects each unit down to exactly these three fields
      // the moment it receives them, so selecting the whole row shipped the
      // product_name / product_sku / product_image_url snapshots on every unit
      // for nothing. A product with a lot of unsold units made that the
      // heaviest part of opening the drawer. created_at is kept only because
      // the sort below orders by it.
      const { data: items, error } = await context.supabase
        .from("stock_items")
        .select("id, manufacture_id, purchase_price, created_at")
        .eq("product_id", data.productId)
        .eq("sold", false)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = items ?? [];
      // Employees add units to the cart from here but must not see unit cost.
      if (context.role !== "admin") {
        return rows.map((it) => ({ ...it, purchase_price: 0 }));
      }
      return rows;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
  });

// ---------------------------------------------------------------------------
// Shared paging / filtering input
// ---------------------------------------------------------------------------
// `from` and `to` are epoch-ms bounds on created_at (0 = unbounded). Both are
// computed on the CLIENT so that "today", "this month" and a hand-picked custom
// range all follow the user's local timezone rather than the server's.
const pageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(10),
  search: z.string().max(200).optional().default(""),
  from: z.number().min(0).optional().default(0),
  to: z.number().min(0).optional().default(0),
};

/** Epoch-ms bounds as ISO strings, or null where the bound is open. */
function rangeIso(from: number, to: number) {
  return {
    fromIso: from > 0 ? new Date(from).toISOString() : null,
    toIso: to > 0 ? new Date(to).toISOString() : null,
  };
}

// Build a PostgREST `.or()` ilike filter across columns, or null if the term is
// empty. Strips characters that have meaning in the or-filter grammar so user
// input can't break the query.
function ilikeOrFilter(cols: string[], term: string): string | null {
  const safe = term.replace(/[%,().*]/g, " ").trim();
  if (!safe) return null;
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}

/** "Circular Saw, Blade Set +2 more" — what a transaction row shows at a glance. */
function summarize(names: string[]): string {
  const seen: string[] = [];
  for (const n of names) if (n && !seen.includes(n)) seen.push(n);
  if (!seen.length) return "—";
  const head = seen.slice(0, 2).join(", ");
  return seen.length > 2 ? `${head} +${seen.length - 2} more` : head;
}

// ---------------------------------------------------------------------------
// Selling — one sale, many lines, many units
// ---------------------------------------------------------------------------
// A ticket at the till is ONE sale. `sales` still holds one row per unit
// (each unit carries the purchase price of the specific stock item it came
// from, which is what makes per-unit cost exact), but those rows now hang off a
// sale_orders header. Everything customer-facing — the ledger, pending
// payments, the receipt — reads the header.
const saleAddonInput = z
  .object({
    // A catalogue add-on: drawn FIFO out of its batches by the database.
    addonId: z.string().uuid().optional(),
    // A one-off typed in at the till: no catalogue row, no batch, but it still
    // costs the org money and still comes off this sale's profit.
    name: z.string().max(120).optional(),
    qty: z.number().int().min(1).max(1000),
    unit_cost: z.number().min(0).max(1_000_000).optional(),
    list_value: z.number().min(0).max(1_000_000).optional(),
  })
  .refine((a) => Boolean(a.addonId) !== Boolean(a.name?.trim()), {
    message: "An add-on is either a catalogue item or a named custom one, not both",
  });

export const createSale = createServerFn({ method: "POST" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) =>
    z
      .object({
        items: z
          .array(
            z.object({
              stockItemId: z.string().uuid(),
              selling_price: z.number().min(0).optional(),
              net_payment: z.number().min(0).optional(),
              // Free extras handed over with THIS unit. They never change what
              // the customer pays — they come off the sale's profit instead.
              // Attached after the sale row exists, because an add-on cannot
              // exist without one.
              addons: z.array(saleAddonInput).max(20).optional(),
            }),
          )
          .min(1)
          .max(200),
        customer_name: z.string().max(200).nullable().optional(),
        customer_contact: z.string().max(200).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
        // Already uploaded by the browser before this call — storage rejects a
        // path outside the caller's org folder, so a forged value here cannot
        // point at another tenant's object.
        receipt_path: z.string().max(500).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const ids = data.items.map((i) => i.stockItemId);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate stock item in this sale");

    try {
      // 1 read: all referenced stock items
      const itemsRes = await context.supabase.from("stock_items").select("*").in("id", ids);
      if (itemsRes.error) throw itemsRes.error;
      const items = (itemsRes.data ?? []) as StockItemRow[];
      const byId = new Map(items.map((it) => [it.id, it]));

      for (const id of ids) {
        const it = byId.get(id);
        if (!it) throw new Error("Stock item not found");
        if (it.sold) throw new Error("A stock item in this sale was already sold");
        if (!it.product_id) throw new Error("A product in this sale no longer exists");
      }

      // The product snapshot read and the "mark sold" update both only need data
      // we already have (product ids / stock item ids), so run them together.
      // The flip is guarded by sold=false so a concurrent sale can't double-sell;
      // its returned rows are exactly the ones we claimed.
      const productIds = [...new Set(items.map((it) => it.product_id as string))];
      const soldAt = new Date().toISOString();
      const [prodRes, flipRes] = await Promise.all([
        context.supabase
          .from("products")
          .select("id, name, sku, image_url, stock")
          .in("id", productIds),
        context.supabase
          .from("stock_items")
          .update({ sold: true, sold_at: soldAt })
          .in("id", ids)
          .eq("sold", false)
          .select("id"),
      ]);
      if (prodRes.error) throw prodRes.error;
      const prodById = new Map((prodRes.data ?? []).map((p) => [p.id, p]));
      if (flipRes.error) throw flipRes.error;
      if ((flipRes.data ?? []).length !== ids.length) {
        throw new Error("A stock item in this sale was just sold — refresh and retry");
      }

      // Unmark the units if anything after this point fails. Without it a failed
      // checkout would leave stock flagged sold with no sale to show for it.
      const releaseUnits = async () => {
        await context.supabase
          .from("stock_items")
          .update({ sold: false, sold_at: null })
          .in("id", ids);
      };

      // 1. The sale header. Its totals are derived from the lines by a trigger,
      //    so nothing here writes an amount that could drift from the rows.
      let orderId: string;
      try {
        const res = await context.supabase
          .from("sale_orders")
          .insert({
            org_id: context.orgId,
            user_id: context.userId,
            customer_name: data.customer_name?.trim() || null,
            customer_contact: data.customer_contact?.trim() || null,
            note: data.note?.trim() || null,
            receipt_path: data.receipt_path || null,
          })
          .select("id")
          .single();
        if (res.error) throw res.error;
        orderId = res.data.id as string;
      } catch (err: any) {
        await releaseUnits();
        const hint = missingTableMessage(err, true);
        throw new Error(hint ?? err?.message ?? String(err));
      }

      // 2. Every unit sold, in one insert, all pointing at the header.
      const saleRows = data.items.map((line) => {
        const it = byId.get(line.stockItemId)!;
        const snap = prodById.get(it.product_id as string);
        return {
          ...buildSaleRow({
            product_id: it.product_id as string,
            stock_item_id: it.id,
            org_id: context.orgId,
            user_id: context.userId,
            product_name: snap?.name ?? it.product_name ?? null,
            product_sku: snap?.sku ?? it.product_sku ?? null,
            product_image_url: snap?.image_url ?? it.product_image_url ?? null,
            selling_price: line.selling_price,
            net_payment: line.net_payment,
            customer_name: data.customer_name,
            customer_contact: data.customer_contact,
          }),
          order_id: orderId,
        };
      });

      const salesRes = await context.supabase.from("sales").insert(saleRows).select();
      if (salesRes.error) {
        // A header with no lines is a phantom sale — and its totals would read
        // as a real zero-value transaction forever. Take it back out.
        await context.supabase.from("sale_orders").delete().eq("id", orderId);
        await releaseUnits();
        throw salesRes.error;
      }
      const saleRowsBack = (salesRes.data ?? []) as SaleRow[];

      // decrement product stock by the number of units sold from each product —
      // distinct products are independent, so update them concurrently.
      const soldPerProduct = new Map<string, number>();
      for (const it of items) {
        const pid = it.product_id as string;
        soldPerProduct.set(pid, (soldPerProduct.get(pid) ?? 0) + 1);
      }
      await Promise.all(
        [...soldPerProduct].map(([pid, n]) => applyStockDelta(context.supabase, pid, -n)),
      );

      // Attach the free add-ons, now that the sales they hang off exist.
      //
      // Matched by stock_item_id rather than by array position: a stock unit is
      // in this sale at most once (checked above), so it identifies its sale row
      // exactly, and we never depend on the insert returning rows in the order
      // they were sent.
      const addonResult = await attachSaleAddons(context.supabase, data.items, saleRowsBack);

      return { orderId, sold: ids.length, sales: saleRowsBack, ...addonResult };
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
  });

// ---------------------------------------------------------------------------
// Sales ledger — one row per SALE
// ---------------------------------------------------------------------------
export interface SaleOrderRow {
  id: string;
  created_at: string;
  customer_name: string | null;
  customer_contact: string | null;
  /** Distinct products on the sale, and total units across them. */
  line_count: number;
  unit_count: number;
  item_summary: string;
  total_amount: number;
  net_payment: number;
  pending_payment: number;
  payment_status: string;
  /** Admin-only, zeroed for employees before the response leaves the server. */
  cost: number;
  profit: number;
  addon_cost: number;
  /** Not a cost, so employees see it: what was handed over, not what it was worth. */
  addon_units: number;
}

export interface SaleStats {
  count: number;
  units: number;
  revenue: number;
  profit: number;
  outstanding: number;
}

export interface PagedSales {
  rows: SaleOrderRow[];
  total: number;
  stats: SaleStats;
}

/**
 * One page of SALES, newest first — one row per transaction, not per unit.
 *
 * Cost and profit are rolled up from the sale's own lines: each line's cost is
 * the purchase price of the exact stock unit it sold, plus whatever add-ons
 * went out with it. Employees may see the ledger but never cost or profit, so
 * those fields are zeroed here rather than hidden in the UI — the numbers never
 * reach the browser.
 */
export const listSalesPage = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedSales> => {
    const { page, pageSize, search, from, to } = data;
    const { fromIso, toIso } = rangeIso(from, to);
    const offset = (page - 1) * pageSize;
    const hideCost = context.role !== "admin";

    // A search term can match the customer on the header OR a product on one of
    // the lines. The line match is resolved first, to a set of order ids, then
    // folded into the header filter — PostgREST cannot express "orders whose
    // children match" in a single filter.
    let lineOrderIds: string[] | null = null;
    if (search.trim()) {
      const lineOr = ilikeOrFilter(["product_name", "product_sku"], search);
      if (lineOr) {
        const res = await context.supabase
          .from("sales")
          .select("order_id")
          .eq("org_id", context.orgId)
          .not("order_id", "is", null)
          .or(lineOr)
          .limit(2000);
        lineOrderIds = [
          ...new Set(((res.data ?? []) as { order_id: string }[]).map((r) => r.order_id)),
        ];
      }
    }

    const applyFilters = (q: any) => {
      let out = q.eq("org_id", context.orgId);
      if (fromIso) out = out.gte("created_at", fromIso);
      if (toIso) out = out.lte("created_at", toIso);
      const headerOr = ilikeOrFilter(["customer_name", "customer_contact", "note"], search);
      if (headerOr) {
        const clauses = [headerOr];
        if (lineOrderIds?.length) clauses.push(`id.in.(${lineOrderIds.join(",")})`);
        out = out.or(clauses.join(","));
      }
      return out;
    };

    const cols =
      "id, created_at, customer_name, customer_contact, line_count, unit_count, total_amount, net_payment, pending_payment, payment_status";

    let pq = applyFilters(context.supabase.from("sale_orders").select(cols, { count: "exact" }));
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    // The aggregate covers the WHOLE filtered set so the KPI cards stay true
    // while the table is paged. One narrow row per sale, not per unit.
    const aq = applyFilters(
      context.supabase.from("sale_orders").select("id, total_amount, pending_payment, unit_count"),
    );

    const [pageRes, aggRes] = await Promise.all([pq, aq]);
    if (pageRes.error) {
      const hint = missingTableMessage(pageRes.error, true);
      throw new Error(hint ?? pageRes.error.message);
    }
    if (aggRes.error) throw new Error(aggRes.error.message);

    type OrderSel = {
      id: string;
      created_at: string;
      customer_name: string | null;
      customer_contact: string | null;
      line_count: number;
      unit_count: number;
      total_amount: number;
      net_payment: number;
      pending_payment: number;
      payment_status: string;
    };
    const orders = (pageRes.data ?? []) as OrderSel[];
    const total = pageRes.count ?? 0;

    let revenue = 0;
    let outstanding = 0;
    let units = 0;
    const allIds: string[] = [];
    for (const o of (aggRes.data ?? []) as {
      id: string;
      total_amount: number;
      pending_payment: number;
      unit_count: number;
    }[]) {
      revenue += Number(o.total_amount) || 0;
      outstanding += Number(o.pending_payment) || 0;
      units += Number(o.unit_count) || 0;
      allIds.push(o.id);
    }

    // Per-row cost/profit needs the lines of the orders ON THIS PAGE only.
    // The filtered-set profit total needs every filtered order's lines, which
    // is why it is skipped entirely for employees — who never see it anyway.
    const pageIds = orders.map((o) => o.id);
    const [pageLines, statsProfit] = await Promise.all([
      saleLineRollup(context.supabase, context.orgId, pageIds, hideCost),
      hideCost
        ? Promise.resolve(0)
        : saleLineRollup(context.supabase, context.orgId, allIds, false).then((m) =>
            [...m.values()].reduce((n, v) => n + (v.revenue - v.cost - v.addonCost), 0),
          ),
    ]);

    const rows: SaleOrderRow[] = orders.map((o) => {
      const roll = pageLines.get(o.id);
      const amount = Number(o.total_amount) || 0;
      const cost = roll?.cost ?? 0;
      const addonCost = roll?.addonCost ?? 0;
      return {
        id: o.id,
        created_at: o.created_at,
        customer_name: o.customer_name,
        customer_contact: o.customer_contact,
        line_count: Number(o.line_count) || 0,
        unit_count: Number(o.unit_count) || 0,
        item_summary: roll?.summary ?? "—",
        total_amount: amount,
        net_payment: Number(o.net_payment) || 0,
        pending_payment: Number(o.pending_payment) || 0,
        payment_status: o.payment_status,
        cost: hideCost ? 0 : cost,
        profit: hideCost ? 0 : amount - cost - addonCost,
        addon_cost: hideCost ? 0 : addonCost,
        addon_units: roll?.addonUnits ?? 0,
      };
    });

    return {
      rows,
      total,
      stats: {
        count: total,
        units,
        revenue,
        profit: hideCost ? 0 : statsProfit,
        outstanding,
      },
    };
  });

/**
 * Roll the line-level facts of many sales up to their headers in two queries.
 *
 * Cost lives on `stock_items` (the purchase price of the exact unit sold) and
 * add-on cost on the `sale_addon_totals` view, so a naive implementation would
 * be three round trips per sale. This does the whole page at once. `hideCost`
 * skips the cost lookups entirely for employees — the cheapest way to guarantee
 * a number cannot leak is not to fetch it.
 */
async function saleLineRollup(
  supabase: any,
  orgId: string,
  orderIds: string[],
  hideCost: boolean,
): Promise<
  Map<
    string,
    { revenue: number; cost: number; addonCost: number; addonUnits: number; summary: string }
  >
> {
  const out = new Map<
    string,
    { revenue: number; cost: number; addonCost: number; addonUnits: number; summary: string }
  >();
  if (!orderIds.length) return out;

  const { data: lines, error } = await supabase
    .from("sales")
    .select("id, order_id, product_name, selling_price, stock_item_id")
    .eq("org_id", orgId)
    .in("order_id", orderIds);
  if (error) return out;

  const rows = (lines ?? []) as {
    id: string;
    order_id: string;
    product_name: string | null;
    selling_price: number;
    stock_item_id: string | null;
  }[];

  const stockIds = [...new Set(rows.map((r) => r.stock_item_id).filter(Boolean))] as string[];
  const [costById, addonBySale] = await Promise.all([
    hideCost || !stockIds.length
      ? Promise.resolve(new Map<string, number>())
      : supabase
          .from("stock_items")
          .select("id, purchase_price")
          .in("id", stockIds)
          .then((r: any) => {
            const m = new Map<string, number>();
            for (const s of r.data ?? []) m.set(s.id, Number(s.purchase_price) || 0);
            return m;
          }),
    saleAddonTotals(
      supabase,
      orgId,
      rows.map((r) => r.id),
    ),
  ]);

  const names = new Map<string, string[]>();
  for (const r of rows) {
    const acc = out.get(r.order_id) ?? {
      revenue: 0,
      cost: 0,
      addonCost: 0,
      addonUnits: 0,
      summary: "—",
    };
    acc.revenue += Number(r.selling_price) || 0;
    if (!hideCost && r.stock_item_id) acc.cost += costById.get(r.stock_item_id) ?? 0;
    const addon = addonBySale.get(r.id);
    if (addon) {
      if (!hideCost) acc.addonCost += addon.cost;
      acc.addonUnits += addon.units;
    }
    out.set(r.order_id, acc);
    const list = names.get(r.order_id) ?? [];
    list.push(r.product_name ?? "Deleted product");
    names.set(r.order_id, list);
  }
  for (const [orderId, acc] of out) acc.summary = summarize(names.get(orderId) ?? []);
  return out;
}

/** sale_id → add-on cost + units, for a bounded set of sales. */
async function saleAddonTotals(
  supabase: any,
  orgId: string,
  saleIds: string[],
): Promise<Map<string, { cost: number; units: number }>> {
  const map = new Map<string, { cost: number; units: number }>();
  if (!saleIds.length) return map;
  const { data, error } = await supabase
    .from("sale_addon_totals")
    .select("sale_id, addon_cost, addon_units")
    .eq("org_id", orgId)
    .in("sale_id", saleIds);
  // A deploy that has not run the add-on migration simply has no add-ons, which
  // is the correct answer then — don't fail the whole ledger over it.
  if (error) return map;
  for (const r of data ?? []) {
    map.set(r.sale_id as string, {
      cost: Number(r.addon_cost) || 0,
      units: Number(r.addon_units) || 0,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Sale detail — everything recorded about one sale
// ---------------------------------------------------------------------------
export interface SaleUnit {
  /** the `sales` row id — this is what settle/refund would address */
  sale_id: string;
  stock_item_id: string | null;
  manufacture_id: string | null;
  selling_price: number;
  net_payment: number;
  pending_payment: number;
  cost: number;
  addons: { name: string; code: string; quantity: number; unit_cost: number; is_custom: boolean }[];
  addon_cost: number;
}

export interface SaleDetailLine {
  product_id: string | null;
  product_name: string;
  sku: string;
  image_url: string | null;
  quantity: number;
  /** null when the units on this line went out at different prices */
  unit_price: number | null;
  mixed_price: boolean;
  total: number;
  cost: number;
  addon_cost: number;
  profit: number;
  units: SaleUnit[];
}

export interface SaleDetail {
  id: string;
  created_at: string;
  customer_name: string | null;
  customer_contact: string | null;
  note: string | null;
  receipt_path: string | null;
  unit_count: number;
  line_count: number;
  total_amount: number;
  net_payment: number;
  pending_payment: number;
  payment_status: string;
  cost: number;
  addon_cost: number;
  addon_units: number;
  profit: number;
  lines: SaleDetailLine[];
}

/**
 * Full record of one sale: the header, every product on it, and every
 * individual unit under each product with its own price, payment, cost and the
 * add-ons that went out with it.
 *
 * Grouped by product rather than returned flat, because "3 × Circular Saw" is
 * how the sale actually happened — the per-unit rows underneath exist so that a
 * unit sold at a custom price, or carrying its own giveaway, is still visible
 * instead of averaged away.
 */
export const getSaleDetail = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }): Promise<SaleDetail> => {
    const hideCost = context.role !== "admin";

    const orderRes = await context.supabase
      .from("sale_orders")
      .select(
        "id, created_at, customer_name, customer_contact, note, receipt_path, unit_count, line_count, total_amount, net_payment, pending_payment, payment_status",
      )
      .eq("org_id", context.orgId)
      .eq("id", data.id)
      .maybeSingle();
    if (orderRes.error) {
      const hint = missingTableMessage(orderRes.error, true);
      throw new Error(hint ?? orderRes.error.message);
    }
    if (!orderRes.data) throw new Error("Sale not found");
    const order = orderRes.data as any;

    const linesRes = await context.supabase
      .from("sales")
      .select(
        "id, product_id, product_name, product_sku, product_image_url, stock_item_id, selling_price, net_payment, pending_payment, created_at",
      )
      .eq("org_id", context.orgId)
      .eq("order_id", data.id)
      .order("created_at", { ascending: true });
    if (linesRes.error) throw new Error(linesRes.error.message);

    type LineSel = {
      id: string;
      product_id: string | null;
      product_name: string | null;
      product_sku: string | null;
      product_image_url: string | null;
      stock_item_id: string | null;
      selling_price: number;
      net_payment: number;
      pending_payment: number;
    };
    const saleRows = (linesRes.data ?? []) as LineSel[];

    const productIds = [...new Set(saleRows.map((r) => r.product_id).filter(Boolean))] as string[];
    const stockIds = [...new Set(saleRows.map((r) => r.stock_item_id).filter(Boolean))] as string[];

    const [prodRes, stockRes, addonRes] = await Promise.all([
      productIds.length
        ? context.supabase.from("products").select("id, name, sku, image_url").in("id", productIds)
        : Promise.resolve({ data: [], error: null } as const),
      stockIds.length
        ? context.supabase
            .from("stock_items")
            .select("id, manufacture_id, purchase_price")
            .in("id", stockIds)
        : Promise.resolve({ data: [], error: null } as const),
      saleRows.length
        ? context.supabase
            .from("sale_addons")
            .select("sale_id, addon_name, addon_code, quantity, unit_cost, total_cost, is_custom")
            .eq("org_id", context.orgId)
            .in(
              "sale_id",
              saleRows.map((r) => r.id),
            )
        : Promise.resolve({ data: [], error: null } as const),
    ]);

    // Live product preferred over the snapshot, so a rename shows through.
    const liveById = new Map<string, { name: string; sku: string; image_url: string | null }>();
    if (!prodRes.error) {
      for (const p of (prodRes.data ?? []) as any[]) {
        liveById.set(p.id, { name: p.name, sku: p.sku, image_url: p.image_url ?? null });
      }
    }

    const unitById = new Map<string, { manufacture_id: string | null; purchase_price: number }>();
    if (!stockRes.error) {
      for (const s of (stockRes.data ?? []) as any[]) {
        unitById.set(s.id, {
          manufacture_id: s.manufacture_id ?? null,
          purchase_price: Number(s.purchase_price) || 0,
        });
      }
    }

    const addonsBySale = new Map<string, SaleUnit["addons"]>();
    if (!addonRes.error) {
      for (const a of (addonRes.data ?? []) as any[]) {
        const list = addonsBySale.get(a.sale_id) ?? [];
        list.push({
          name: a.addon_name ?? "Add-on",
          code: a.addon_code ?? "—",
          quantity: Number(a.quantity) || 0,
          // An employee sees WHAT went out but not what it cost the org.
          unit_cost: hideCost ? 0 : Number(a.unit_cost) || 0,
          is_custom: Boolean(a.is_custom),
        });
        addonsBySale.set(a.sale_id, list);
      }
    }

    // Group units under their product. Map keeps insertion order, so lines come
    // back in the order they were rung up.
    const grouped = new Map<string, SaleDetailLine>();
    for (const r of saleRows) {
      const key = r.product_id ?? `deleted:${r.product_sku ?? r.id}`;
      const live = r.product_id ? liveById.get(r.product_id) : undefined;
      const unitInfo = r.stock_item_id ? unitById.get(r.stock_item_id) : undefined;
      const addons = addonsBySale.get(r.id) ?? [];
      const addonCost = addons.reduce((n, a) => n + a.unit_cost * a.quantity, 0);
      const cost = hideCost ? 0 : (unitInfo?.purchase_price ?? 0);

      const line =
        grouped.get(key) ??
        ({
          product_id: r.product_id,
          product_name: live?.name ?? r.product_name ?? "Deleted product",
          sku: live?.sku ?? r.product_sku ?? "—",
          image_url: live?.image_url ?? r.product_image_url ?? null,
          quantity: 0,
          unit_price: null,
          mixed_price: false,
          total: 0,
          cost: 0,
          addon_cost: 0,
          profit: 0,
          units: [],
        } as SaleDetailLine);

      const selling = Number(r.selling_price) || 0;
      line.quantity += 1;
      line.total += selling;
      line.cost += cost;
      line.addon_cost += addonCost;
      line.units.push({
        sale_id: r.id,
        stock_item_id: r.stock_item_id,
        manufacture_id: hideCost ? null : (unitInfo?.manufacture_id ?? null),
        selling_price: selling,
        net_payment: Number(r.net_payment) || 0,
        pending_payment: Number(r.pending_payment) || 0,
        cost,
        addons,
        addon_cost: addonCost,
      });
      grouped.set(key, line);
    }

    const lines = [...grouped.values()].map((l) => {
      const prices = new Set(l.units.map((u) => u.selling_price));
      return {
        ...l,
        mixed_price: prices.size > 1,
        unit_price: prices.size === 1 ? [...prices][0] : null,
        profit: hideCost ? 0 : l.total - l.cost - l.addon_cost,
      };
    });

    const cost = lines.reduce((n, l) => n + l.cost, 0);
    const addonCost = lines.reduce((n, l) => n + l.addon_cost, 0);
    const addonUnits = lines.reduce(
      (n, l) => n + l.units.reduce((m, u) => m + u.addons.reduce((k, a) => k + a.quantity, 0), 0),
      0,
    );
    const totalAmount = Number(order.total_amount) || 0;

    return {
      id: order.id,
      created_at: order.created_at,
      customer_name: order.customer_name,
      customer_contact: order.customer_contact,
      note: order.note,
      receipt_path: order.receipt_path ?? null,
      unit_count: Number(order.unit_count) || 0,
      line_count: Number(order.line_count) || 0,
      total_amount: totalAmount,
      net_payment: Number(order.net_payment) || 0,
      pending_payment: Number(order.pending_payment) || 0,
      payment_status: order.payment_status,
      cost: hideCost ? 0 : cost,
      addon_cost: hideCost ? 0 : addonCost,
      addon_units: addonUnits,
      profit: hideCost ? 0 : totalAmount - cost - addonCost,
      lines,
    };
  });

// ---------------------------------------------------------------------------
// Purchases ledger — one row per PURCHASE
// ---------------------------------------------------------------------------
// `stock_orders` was already the header of a supplier run; the ledger just never
// listed it. It listed the units instead, so a purchase of forty blades filled
// four pages. Now the row IS the purchase, and the units live on its detail page.
export interface PurchaseOrderRow {
  id: string;
  created_at: string;
  supplier: string | null;
  note: string | null;
  receipt_path: string | null;
  /** machinery, kept apart from add-ons so "spend on machinery" stays answerable */
  total_cost: number;
  unit_count: number;
  addon_cost: number;
  addon_unit_count: number;
  grand_total: number;
  total_units: number;
  line_count: number;
  item_summary: string;
  /** units from this purchase still on the shelf (unsold machines + batch remainder) */
  still_in_stock: number;
}

export interface PurchaseStats {
  count: number;
  totalSpend: number;
  machinerySpend: number;
  addonSpend: number;
  units: number;
}

export interface PagedPurchases {
  rows: PurchaseOrderRow[];
  total: number;
  stats: PurchaseStats;
}

export const listPurchasesPage = createServerFn({ method: "GET" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedPurchases> => {
    const { page, pageSize, search, from, to } = data;
    const { fromIso, toIso } = rangeIso(from, to);
    const offset = (page - 1) * pageSize;

    // As on the sales side, a search term can match the header (supplier, note)
    // or an item on one of the lines. Line matches resolve to order ids first.
    let lineOrderIds: string[] | null = null;
    if (search.trim()) {
      const mOr = ilikeOrFilter(["product_name", "product_sku", "manufacture_id"], search);
      const aOr = ilikeOrFilter(["addon_name", "addon_code", "batch_code"], search);
      const [mRes, aRes] = await Promise.all([
        mOr
          ? context.supabase
              .from("stock_items")
              .select("order_id")
              .eq("org_id", context.orgId)
              .not("order_id", "is", null)
              .or(mOr)
              .limit(2000)
          : Promise.resolve({ data: [], error: null } as const),
        aOr
          ? context.supabase
              .from("addon_stock_batches")
              .select("order_id")
              .eq("org_id", context.orgId)
              .not("order_id", "is", null)
              .or(aOr)
              .limit(2000)
          : Promise.resolve({ data: [], error: null } as const),
      ]);
      const ids = new Set<string>();
      for (const r of ((mRes as any).data ?? []) as { order_id: string }[]) ids.add(r.order_id);
      for (const r of ((aRes as any).data ?? []) as { order_id: string }[]) ids.add(r.order_id);
      lineOrderIds = [...ids];
    }

    const applyFilters = (q: any) => {
      let out = q.eq("org_id", context.orgId);
      if (fromIso) out = out.gte("created_at", fromIso);
      if (toIso) out = out.lte("created_at", toIso);
      const headerOr = ilikeOrFilter(["supplier", "note"], search);
      if (headerOr) {
        const clauses = [headerOr];
        if (lineOrderIds?.length) clauses.push(`id.in.(${lineOrderIds.join(",")})`);
        out = out.or(clauses.join(","));
      }
      return out;
    };

    const cols =
      "id, created_at, supplier, note, receipt_path, total_cost, unit_count, addon_cost, addon_unit_count";

    let pq = applyFilters(context.supabase.from("stock_orders").select(cols, { count: "exact" }));
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    const aq = applyFilters(
      context.supabase
        .from("stock_orders")
        .select("total_cost, unit_count, addon_cost, addon_unit_count"),
    );

    const [pageRes, aggRes] = await Promise.all([pq, aq]);
    if (pageRes.error) {
      const hint = missingTableMessage(pageRes.error, true);
      throw new Error(hint ?? pageRes.error.message);
    }
    if (aggRes.error) throw new Error(aggRes.error.message);

    type OrderSel = {
      id: string;
      created_at: string;
      supplier: string | null;
      note: string | null;
      receipt_path: string | null;
      total_cost: number;
      unit_count: number;
      addon_cost: number;
      addon_unit_count: number;
    };
    const orders = (pageRes.data ?? []) as OrderSel[];
    const total = pageRes.count ?? 0;

    const stats: PurchaseStats = {
      count: total,
      totalSpend: 0,
      machinerySpend: 0,
      addonSpend: 0,
      units: 0,
    };
    for (const o of (aggRes.data ?? []) as OrderSel[]) {
      const machinery = Number(o.total_cost) || 0;
      const addon = Number(o.addon_cost) || 0;
      stats.machinerySpend += machinery;
      stats.addonSpend += addon;
      stats.totalSpend += machinery + addon;
      stats.units += (Number(o.unit_count) || 0) + (Number(o.addon_unit_count) || 0);
    }

    const rollup = await purchaseLineRollup(
      context.supabase,
      context.orgId,
      orders.map((o) => o.id),
    );

    const rows: PurchaseOrderRow[] = orders.map((o) => {
      const roll = rollup.get(o.id);
      const machinery = Number(o.total_cost) || 0;
      const addon = Number(o.addon_cost) || 0;
      return {
        id: o.id,
        created_at: o.created_at,
        supplier: o.supplier,
        note: o.note,
        receipt_path: o.receipt_path,
        total_cost: machinery,
        unit_count: Number(o.unit_count) || 0,
        addon_cost: addon,
        addon_unit_count: Number(o.addon_unit_count) || 0,
        grand_total: machinery + addon,
        total_units: (Number(o.unit_count) || 0) + (Number(o.addon_unit_count) || 0),
        line_count: roll?.lineCount ?? 0,
        item_summary: roll?.summary ?? "—",
        still_in_stock: roll?.stillInStock ?? 0,
      };
    });

    return { rows, total, stats };
  });

/** Item names, line count and remaining stock for a bounded set of purchases. */
async function purchaseLineRollup(
  supabase: any,
  orgId: string,
  orderIds: string[],
): Promise<Map<string, { summary: string; lineCount: number; stillInStock: number }>> {
  const out = new Map<string, { summary: string; lineCount: number; stillInStock: number }>();
  if (!orderIds.length) return out;

  const [itemsRes, batchRes] = await Promise.all([
    supabase
      .from("stock_items")
      .select("order_id, product_id, product_name, sold")
      .eq("org_id", orgId)
      .in("order_id", orderIds),
    supabase
      .from("addon_stock_batches")
      .select("order_id, addon_id, addon_name, remaining")
      .eq("org_id", orgId)
      .in("order_id", orderIds),
  ]);

  const names = new Map<string, string[]>();
  const keys = new Map<string, Set<string>>();
  const bump = (orderId: string, name: string, key: string, inStock: number) => {
    const acc = out.get(orderId) ?? { summary: "—", lineCount: 0, stillInStock: 0 };
    acc.stillInStock += inStock;
    out.set(orderId, acc);
    const list = names.get(orderId) ?? [];
    list.push(name);
    names.set(orderId, list);
    const set = keys.get(orderId) ?? new Set<string>();
    set.add(key);
    keys.set(orderId, set);
  };

  if (!itemsRes.error) {
    for (const it of (itemsRes.data ?? []) as any[]) {
      bump(
        it.order_id,
        it.product_name ?? "Deleted product",
        `p:${it.product_id ?? it.product_name}`,
        it.sold ? 0 : 1,
      );
    }
  }
  // A deploy without the add-on migration still gets a working Purchases page.
  if (!batchRes.error) {
    for (const b of (batchRes.data ?? []) as any[]) {
      bump(
        b.order_id,
        b.addon_name ?? "Deleted add-on",
        `a:${b.addon_id ?? b.addon_name}`,
        Number(b.remaining) || 0,
      );
    }
  }

  for (const [orderId, acc] of out) {
    acc.summary = summarize(names.get(orderId) ?? []);
    acc.lineCount = keys.get(orderId)?.size ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Purchase detail — every unit and every price on one supplier run
// ---------------------------------------------------------------------------
export interface PurchaseUnit {
  id: string;
  /** manufacture id (machinery) or batch code (add-on) */
  reference: string;
  unit_price: number;
  /** machinery: this unit has been sold. add-on: the batch is used up. */
  sold: boolean;
  /** add-on batches only — how many of the batch are left */
  remaining?: number;
  quantity?: number;
}

export interface PurchaseDetailLine {
  kind: "machinery" | "addon";
  item_id: string | null;
  name: string;
  sku: string;
  image_url: string | null;
  quantity: number;
  /** null when the units on this line were bought at different prices */
  unit_price: number | null;
  mixed_price: boolean;
  total: number;
  still_in_stock: number;
  units: PurchaseUnit[];
}

export interface PurchaseDetail {
  id: string;
  created_at: string;
  supplier: string | null;
  note: string | null;
  receipt_path: string | null;
  total_cost: number;
  unit_count: number;
  addon_cost: number;
  addon_unit_count: number;
  grand_total: number;
  total_units: number;
  still_in_stock: number;
  lines: PurchaseDetailLine[];
}

/**
 * Everything recorded about one purchase: the supplier, the receipt, and every
 * item on it grouped by product — with each individual unit, its manufacture
 * id and the exact price that unit was bought at underneath.
 *
 * A line bought at mixed rates reports `unit_price: null` and `mixed_price`
 * rather than an average, because the average is not a price anything was
 * actually bought at, and the per-unit rows are right there.
 */
export const getPurchaseDetail = createServerFn({ method: "GET" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }): Promise<PurchaseDetail> => {
    const orderRes = await context.supabase
      .from("stock_orders")
      .select(
        "id, created_at, supplier, note, receipt_path, total_cost, unit_count, addon_cost, addon_unit_count",
      )
      .eq("org_id", context.orgId)
      .eq("id", data.id)
      .maybeSingle();
    if (orderRes.error) {
      const hint = missingTableMessage(orderRes.error, true);
      throw new Error(hint ?? orderRes.error.message);
    }
    if (!orderRes.data) throw new Error("Purchase not found");
    const order = orderRes.data as any;

    const [itemsRes, batchRes] = await Promise.all([
      context.supabase
        .from("stock_items")
        .select(
          "id, product_id, product_name, product_sku, manufacture_id, purchase_price, sold, created_at",
        )
        .eq("org_id", context.orgId)
        .eq("order_id", data.id)
        .order("created_at", { ascending: true }),
      context.supabase
        .from("addon_stock_batches")
        .select(
          "id, addon_id, addon_name, addon_code, batch_code, quantity, remaining, unit_cost, created_at",
        )
        .eq("org_id", context.orgId)
        .eq("order_id", data.id)
        .order("created_at", { ascending: true }),
    ]);
    if (itemsRes.error) throw new Error(itemsRes.error.message);

    const lines = new Map<string, PurchaseDetailLine>();

    for (const it of (itemsRes.data ?? []) as any[]) {
      const key = `p:${it.product_id ?? it.product_sku ?? it.id}`;
      const line =
        lines.get(key) ??
        ({
          kind: "machinery",
          item_id: it.product_id ?? null,
          name: it.product_name ?? "Deleted product",
          sku: it.product_sku ?? "—",
          image_url: it.product_image_url ?? null,
          quantity: 0,
          unit_price: null,
          mixed_price: false,
          total: 0,
          still_in_stock: 0,
          units: [],
        } as PurchaseDetailLine);
      const price = Number(it.purchase_price) || 0;
      line.quantity += 1;
      line.total += price;
      if (!it.sold) line.still_in_stock += 1;
      line.units.push({
        id: it.id,
        reference: it.manufacture_id ?? "—",
        unit_price: price,
        sold: Boolean(it.sold),
      });
      lines.set(key, line);
    }

    // Batches snapshot the add-on's name and code but not its picture, so the
    // live catalogue row supplies it. Bounded by the add-ons on this purchase.
    const addonImages = new Map<string, string | null>();
    if (!batchRes.error) {
      const addonIds = [
        ...new Set(((batchRes.data ?? []) as any[]).map((b) => b.addon_id).filter(Boolean)),
      ] as string[];
      if (addonIds.length) {
        const res = await context.supabase
          .from("addons")
          .select("id, image_url")
          .in("id", addonIds)
          .eq("org_id", context.orgId);
        if (!res.error) {
          for (const a of (res.data ?? []) as any[]) addonImages.set(a.id, a.image_url ?? null);
        }
      }
    }

    if (!batchRes.error) {
      for (const b of (batchRes.data ?? []) as any[]) {
        // One batch is one lot at one price, so an add-on line groups its
        // batches the way a machinery line groups its units.
        const key = `a:${b.addon_id ?? b.addon_code ?? b.id}`;
        const line =
          lines.get(key) ??
          ({
            kind: "addon",
            item_id: b.addon_id ?? null,
            name: b.addon_name ?? "Deleted add-on",
            sku: b.addon_code ?? "—",
            image_url: b.addon_id ? (addonImages.get(b.addon_id) ?? null) : null,
            quantity: 0,
            unit_price: null,
            mixed_price: false,
            total: 0,
            still_in_stock: 0,
            units: [],
          } as PurchaseDetailLine);
        const qty = Number(b.quantity) || 0;
        const unit = Number(b.unit_cost) || 0;
        const remaining = Number(b.remaining) || 0;
        line.quantity += qty;
        line.total += qty * unit;
        line.still_in_stock += remaining;
        line.units.push({
          id: b.id,
          reference: b.batch_code,
          unit_price: unit,
          sold: remaining === 0,
          remaining,
          quantity: qty,
        });
        lines.set(key, line);
      }
    }

    const out = [...lines.values()].map((l) => {
      const prices = new Set(l.units.map((u) => u.unit_price));
      return {
        ...l,
        mixed_price: prices.size > 1,
        unit_price: prices.size === 1 ? [...prices][0] : null,
      };
    });

    const machinery = Number(order.total_cost) || 0;
    const addon = Number(order.addon_cost) || 0;
    return {
      id: order.id,
      created_at: order.created_at,
      supplier: order.supplier,
      note: order.note,
      receipt_path: order.receipt_path,
      total_cost: machinery,
      unit_count: Number(order.unit_count) || 0,
      addon_cost: addon,
      addon_unit_count: Number(order.addon_unit_count) || 0,
      grand_total: machinery + addon,
      total_units: (Number(order.unit_count) || 0) + (Number(order.addon_unit_count) || 0),
      still_in_stock: out.reduce((n, l) => n + l.still_in_stock, 0),
      lines: out,
    };
  });

// ---------------------------------------------------------------------------
// Pending payments — what a CUSTOMER still owes, per sale
// ---------------------------------------------------------------------------
// A balance belongs to the sale, not to each unit on it: a customer who took
// three machines and paid half owes one amount, and used to appear three times.
export interface PendingPaymentRow {
  id: string; // sale_orders id
  created_at: string;
  customer_name: string | null;
  customer_contact: string | null;
  item_summary: string;
  unit_count: number;
  total_amount: number;
  net_payment: number;
  pending_payment: number;
  payment_status: string;
}

export interface PagedPending {
  rows: PendingPaymentRow[];
  total: number;
  outstanding: number;
  received: number;
}

export const listPendingPayments = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedPending> => {
    const { page, pageSize, search, from, to } = data;
    const { fromIso, toIso } = rangeIso(from, to);
    const offset = (page - 1) * pageSize;

    let lineOrderIds: string[] | null = null;
    if (search.trim()) {
      const lineOr = ilikeOrFilter(["product_name", "product_sku"], search);
      if (lineOr) {
        const res = await context.supabase
          .from("sales")
          .select("order_id")
          .eq("org_id", context.orgId)
          .not("order_id", "is", null)
          .or(lineOr)
          .limit(2000);
        lineOrderIds = [
          ...new Set(((res.data ?? []) as { order_id: string }[]).map((r) => r.order_id)),
        ];
      }
    }

    const applyFilters = (q: any) => {
      let out = q.eq("org_id", context.orgId).gt("pending_payment", 0);
      if (fromIso) out = out.gte("created_at", fromIso);
      if (toIso) out = out.lte("created_at", toIso);
      const headerOr = ilikeOrFilter(["customer_name", "customer_contact"], search);
      if (headerOr) {
        const clauses = [headerOr];
        if (lineOrderIds?.length) clauses.push(`id.in.(${lineOrderIds.join(",")})`);
        out = out.or(clauses.join(","));
      }
      return out;
    };

    const cols =
      "id, created_at, customer_name, customer_contact, unit_count, total_amount, net_payment, pending_payment, payment_status";

    let pq = applyFilters(context.supabase.from("sale_orders").select(cols, { count: "exact" }));
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    const aq = applyFilters(
      context.supabase.from("sale_orders").select("net_payment, pending_payment"),
    );

    const [pageRes, aggRes] = await Promise.all([pq, aq]);
    if (pageRes.error) {
      const hint = missingTableMessage(pageRes.error, true);
      throw new Error(hint ?? pageRes.error.message);
    }
    if (aggRes.error) throw new Error(aggRes.error.message);

    const orders = (pageRes.data ?? []) as any[];
    let outstanding = 0;
    let received = 0;
    for (const r of (aggRes.data ?? []) as any[]) {
      outstanding += Number(r.pending_payment) || 0;
      received += Number(r.net_payment) || 0;
    }

    const rollup = await saleLineRollup(
      context.supabase,
      context.orgId,
      orders.map((o) => o.id),
      true, // cost is irrelevant here, and skipping it is one less query
    );

    return {
      rows: orders.map((o) => ({
        id: o.id,
        created_at: o.created_at,
        customer_name: o.customer_name,
        customer_contact: o.customer_contact,
        item_summary: rollup.get(o.id)?.summary ?? "—",
        unit_count: Number(o.unit_count) || 0,
        total_amount: Number(o.total_amount) || 0,
        net_payment: Number(o.net_payment) || 0,
        pending_payment: Number(o.pending_payment) || 0,
        payment_status: o.payment_status,
      })),
      total: pageRes.count ?? 0,
      outstanding,
      received,
    };
  });

/**
 * Settle (fully or partially) what is owed on a sale.
 *
 * The payment is taken against the SALE, but `sales.net_payment` lives per unit,
 * so the amount is spread across the sale's units in order, filling each one up
 * to its selling price before moving to the next. Which unit a rupee is credited
 * to has no accounting meaning here — the customer owes the sale, not the unit —
 * and filling in order keeps a partially-paid sale readable ("two paid, one
 * outstanding") instead of smearing a fraction across every line.
 *
 * The header's totals and status are recomputed by a database trigger from the
 * rows this writes, so they cannot disagree with them.
 */
export const settlePayment = createServerFn({ method: "POST" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) =>
    z.object({ saleId: z.string().uuid(), net_payment: z.number().min(0) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const orderRes = await context.supabase
      .from("sale_orders")
      .select("id, total_amount")
      .eq("id", data.saleId)
      .eq("org_id", context.orgId)
      .maybeSingle();
    if (orderRes.error) {
      const hint = missingTableMessage(orderRes.error, true);
      throw new Error(hint ?? orderRes.error.message);
    }
    if (!orderRes.data) throw new Error("Sale not found");

    const total = Number((orderRes.data as any).total_amount) || 0;
    if (data.net_payment > total) {
      throw new Error("Payment cannot exceed the sale total");
    }

    const linesRes = await context.supabase
      .from("sales")
      .select("id, selling_price, net_payment")
      .eq("org_id", context.orgId)
      .eq("order_id", data.saleId)
      .order("created_at", { ascending: true });
    if (linesRes.error) throw new Error(linesRes.error.message);
    const lines = (linesRes.data ?? []) as {
      id: string;
      selling_price: number;
      net_payment: number;
    }[];
    if (!lines.length) throw new Error("This sale has no lines to settle");

    // Spread the payment across the units, filling each to its price in turn.
    let left = data.net_payment;
    const updates: { id: string; net_payment: number }[] = [];
    for (const l of lines) {
      const price = Number(l.selling_price) || 0;
      const take = Math.min(left, price);
      left -= take;
      if (take !== (Number(l.net_payment) || 0)) updates.push({ id: l.id, net_payment: take });
    }

    // Sequential, NOT Promise.all, even though the rows are distinct. Every
    // write here fires the trigger that recomputes the order header from all of
    // its lines, and those recounts run in separate transactions — fired
    // concurrently, the last one to commit can be working from a snapshot taken
    // before its siblings landed, leaving the header short by whatever they
    // added. Serialising costs a few round trips on a handful of rows and makes
    // the total exact.
    const priceById = new Map(lines.map((l) => [l.id, Number(l.selling_price) || 0]));
    for (const u of updates) {
      const res = await context.supabase
        .from("sales")
        .update({
          net_payment: u.net_payment,
          payment_status: (priceById.get(u.id) ?? 0) - u.net_payment > 0 ? "pending" : "completed",
        })
        .eq("id", u.id)
        .eq("org_id", context.orgId);
      if (res.error) throw new Error(res.error.message);
    }

    const after = await context.supabase
      .from("sale_orders")
      .select("id, total_amount, net_payment, pending_payment, payment_status")
      .eq("id", data.saleId)
      .eq("org_id", context.orgId)
      .single();
    if (after.error) throw new Error(after.error.message);
    return after.data;
  });
