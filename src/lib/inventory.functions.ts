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

export const duplicateProduct = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: src, error: e1 } = await context.supabase
      .from("products")
      .select("*")
      .eq("id", data.id)
      .eq("org_id", context.orgId)
      .single<ProductRow>();
    if (e1 || !src) throw new Error(e1?.message ?? "Not found");
    const copy = {
      org_id: context.orgId,
      user_id: context.userId,
      name: `${src.name} (copy)`,
      sku: `${src.sku}-C`,
      image_url: src.image_url,
      category: src.category,
      description: src.description,
      stock: src.stock,
      reorder_at: src.reorder_at,
      purchase_price: src.purchase_price,
      selling_price: src.selling_price,
      pinned: false,
    };
    const { data: row, error } = await context.supabase
      .from("products")
      .insert(copy)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as ProductRow;
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

const DEMO = [
  {
    name: "Apex Mitre Saw Pro X1",
    sku: "MS-402-B",
    category: "Power Tools",
    description: "Industrial-grade mitre saw with dual-bevel and integrated laser guide.",
    stock: 48,
    reorder_at: 10,
    purchase_price: 312,
    selling_price: 499,
  },
  {
    name: "Isotope Torque Wrench",
    sku: "TW-99",
    category: "Hand Tools",
    description: "Calibrated click-style torque wrench with locking collar.",
    stock: 4,
    reorder_at: 8,
    purchase_price: 62,
    selling_price: 124.5,
  },
  {
    name: "Carbon Digital Calipers",
    sku: "CC-01",
    category: "Precision Instruments",
    description: "0-150mm carbon-fiber calipers with 0.01mm resolution.",
    stock: 22,
    reorder_at: 6,
    purchase_price: 28,
    selling_price: 59,
  },
  {
    name: "Helius Safety Goggles",
    sku: "HG-05",
    category: "Safety Equipment",
    description: "ANSI Z87.1+ rated clear polycarbonate goggles.",
    stock: 132,
    reorder_at: 20,
    purchase_price: 6,
    selling_price: 18,
  },
  {
    name: "Flux Soldering Station",
    sku: "SX-200",
    category: "Electronics",
    description: "60W digital soldering station, ESD-safe ceramic heater.",
    stock: 9,
    reorder_at: 10,
    purchase_price: 84,
    selling_price: 169,
  },
  {
    name: "Neon Laser Level",
    sku: "LL-12",
    category: "Precision Instruments",
    description: "Self-leveling green-beam cross-line laser, IP65.",
    stock: 17,
    reorder_at: 5,
    purchase_price: 110,
    selling_price: 229,
  },
];

export const seedDemoProducts = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .handler(async ({ context }) => {
    const rows = DEMO.map((p) => ({
      ...p,
      org_id: context.orgId,
      user_id: context.userId,
      image_url: null,
      pinned: false,
    }));
    const { error } = await context.supabase.from("products").insert(rows);
    if (error) throw new Error(error.message);
    return { inserted: rows.length };
  });

// If `err` is a Postgres "relation does not exist" error for a known table,
// returns an actionable migration hint; otherwise null. Callers keep their own
// fallback so non-table errors propagate exactly as before.
function missingTableMessage(err: unknown, withOriginal = false): string | null {
  const msg = String((err as { message?: unknown })?.message ?? err);
  for (const table of ["stock_items", "sales", "stock_orders"] as const) {
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

export const createStockOrder = createServerFn({ method: "POST" })
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

export const peekNextStockItem = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object({ productId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: item, error } = await context.supabase
      .from("stock_items")
      .select("*")
      .eq("product_id", data.productId)
      .eq("sold", false)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return item ?? null;
  });

// Shared schema for the optional payment/customer fields captured at sale time.
const salePaymentInput = {
  selling_price: z.number().min(0).optional(),
  net_payment: z.number().min(0).optional(),
  customer_name: z.string().max(200).nullable().optional(),
  customer_contact: z.string().max(200).nullable().optional(),
};

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

// Fetch the product fields snapshotted onto a sale. Returns nulls if absent.
async function fetchProductSnapshot(
  supabase: any,
  productId: string,
): Promise<{ name: string | null; sku: string | null; image_url: string | null }> {
  const { data } = await supabase
    .from("products")
    .select("name, sku, image_url")
    .eq("id", productId)
    .maybeSingle();
  return {
    name: data?.name ?? null,
    sku: data?.sku ?? null,
    image_url: data?.image_url ?? null,
  };
}

// Attach the free add-ons chosen at the till to the sale rows just written.
//
// One RPC for the whole cart rather than one per line: addon_attach_bulk runs
// the lot inside a single transaction, so either every add-on on the cart lands
// or none of them do, and there is no window where half a cart's giveaways have
// been taken out of stock.
//
// A failure here does NOT fail the sale. The sale is already recorded and is
// complete on its own terms — the customer paid for the machine, not for the
// giveaway. Throwing would tell the till that a sale which actually happened had
// failed, which is the worse error. The caller gets `addonWarning` to show.
async function attachCartAddons(
  supabase: any,
  items: { stockItemId: string; addons?: { addonId: string; qty: number }[] }[],
  sales: SaleRow[],
): Promise<{ addonCost: number; addonWarning: string | null }> {
  const saleByStockItem = new Map<string, string>();
  for (const s of sales) {
    if (s.stock_item_id) saleByStockItem.set(s.stock_item_id, s.id);
  }

  const lines: { sale_id: string; addon_id: string; qty: number }[] = [];
  for (const it of items) {
    if (!it.addons?.length) continue;
    const saleId = saleByStockItem.get(it.stockItemId);
    if (!saleId) continue;
    for (const a of it.addons) {
      lines.push({ sale_id: saleId, addon_id: a.addonId, qty: a.qty });
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

export const sellOneFromStock = createServerFn({ method: "POST" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) =>
    z.object({ productId: z.string().uuid(), ...salePaymentInput }).parse(d),
  )
  .handler(async ({ context, data }) => {
    // find next stock item
    let next: StockItemRow | null = null;
    try {
      const res = await context.supabase
        .from("stock_items")
        .select("*")
        .eq("product_id", data.productId)
        .eq("sold", false)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (res.error) throw res.error;
      next = res.data;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
    if (!next) throw new Error("No stock available");

    // mark stock item sold
    let updated: StockItemRow;
    try {
      const res = await context.supabase
        .from("stock_items")
        .update({ sold: true, sold_at: new Date().toISOString() })
        .eq("id", next.id)
        .select()
        .single();
      if (res.error) throw res.error;
      updated = res.data;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }

    // record sale
    const snap = await fetchProductSnapshot(context.supabase, data.productId);
    const saleRow = buildSaleRow({
      product_id: data.productId,
      stock_item_id: next.id,
      org_id: context.orgId,
      user_id: context.userId,
      product_name: snap.name,
      product_sku: snap.sku,
      product_image_url: snap.image_url,
      selling_price: data.selling_price,
      net_payment: data.net_payment,
      customer_name: data.customer_name,
      customer_contact: data.customer_contact,
    });
    let sale: SaleRow;
    try {
      const res = await context.supabase.from("sales").insert(saleRow).select().single();
      if (res.error) throw res.error;
      sale = res.data;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }

    await applyStockDelta(context.supabase, data.productId, -1);

    return { sale, stock_item: updated };
  });

export interface ProfitSaleRow {
  created_at: string;
  selling_price: number;
  cost: number;
  profit: number;
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
  .handler(async ({ context }): Promise<ProfitSaleRow[]> => {
    // sales, cost map and add-on totals are independent — fetch in parallel
    const [salesRes, costRes, addonBySale] = await Promise.all([
      context.supabase
        .from("sales")
        .select("id, selling_price, created_at, stock_item_id")
        .eq("org_id", context.orgId)
        .order("created_at", { ascending: true }),
      context.supabase.from("stock_items").select("id, purchase_price").eq("org_id", context.orgId),
      addonCostBySale(context.supabase, context.orgId),
    ]);

    let sales: {
      id: string;
      selling_price: number;
      created_at: string;
      stock_item_id: string | null;
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
      };
    });
  });

export const getAvailableStockItems = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object({ productId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    try {
      const { data: items, error } = await context.supabase
        .from("stock_items")
        .select("*")
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

export const sellStockItem = createServerFn({ method: "POST" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) =>
    z.object({ stockItemId: z.string().uuid(), ...salePaymentInput }).parse(d),
  )
  .handler(async ({ context, data }) => {
    // mark item sold
    try {
      const res = await context.supabase
        .from("stock_items")
        .select("*")
        .eq("id", data.stockItemId)
        .maybeSingle();
      if (res.error) throw res.error;
      const item = res.data;
      if (!item) throw new Error("Stock item not found");
      if (item.sold) throw new Error("Stock item already sold");
      if (!item.product_id) throw new Error("Product no longer exists");
      const productId = item.product_id;

      const res2 = await context.supabase
        .from("stock_items")
        .update({ sold: true, sold_at: new Date().toISOString() })
        .eq("id", data.stockItemId)
        .select()
        .single();
      if (res2.error) throw res2.error;
      const updated = res2.data;

      const snap = await fetchProductSnapshot(context.supabase, productId);
      const saleRow = buildSaleRow({
        product_id: productId,
        stock_item_id: item.id,
        org_id: context.orgId,
        user_id: context.userId,
        product_name: snap.name,
        product_sku: snap.sku,
        product_image_url: snap.image_url,
        selling_price: data.selling_price,
        net_payment: data.net_payment,
        customer_name: data.customer_name,
        customer_contact: data.customer_contact,
      });
      const res3 = await context.supabase.from("sales").insert(saleRow).select().single();
      if (res3.error) throw res3.error;
      const sale = res3.data;

      await applyStockDelta(context.supabase, productId, -1);

      return { sale, stock_item: updated };
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
  });

// Sell many stock units in one round trip. Replaces N sequential sellStockItem
// calls (each ~4 queries) with a fixed handful of bulk queries: one read of all
// items, one read of the distinct products, one bulk "mark sold", one bulk sale
// insert, then one stock decrement per distinct product. Customer + payment are
// captured per-cart (shared customer) with per-unit selling/net amounts.
export const sellStockItems = createServerFn({ method: "POST" })
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
              addons: z
                .array(
                  z.object({
                    addonId: z.string().uuid(),
                    qty: z.number().int().min(1).max(1000),
                  }),
                )
                .max(20)
                .optional(),
            }),
          )
          .min(1)
          .max(200),
        customer_name: z.string().max(200).nullable().optional(),
        customer_contact: z.string().max(200).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const ids = data.items.map((i) => i.stockItemId);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate stock item in cart");

    try {
      // 1 read: all referenced stock items
      const itemsRes = await context.supabase.from("stock_items").select("*").in("id", ids);
      if (itemsRes.error) throw itemsRes.error;
      const items = (itemsRes.data ?? []) as StockItemRow[];
      const byId = new Map(items.map((it) => [it.id, it]));

      for (const id of ids) {
        const it = byId.get(id);
        if (!it) throw new Error("Stock item not found");
        if (it.sold) throw new Error("A stock item in this cart was already sold");
        if (!it.product_id) throw new Error("A product in this cart no longer exists");
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
        throw new Error("A stock item in this cart was just sold — refresh and retry");
      }

      // 1 insert: every sale row at once
      const saleRows = data.items.map((line) => {
        const it = byId.get(line.stockItemId)!;
        const snap = prodById.get(it.product_id as string);
        return buildSaleRow({
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
        });
      });
      const salesRes = await context.supabase.from("sales").insert(saleRows).select();
      if (salesRes.error) throw salesRes.error;
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
      // in this cart at most once (checked above), so it identifies its sale row
      // exactly, and we never depend on the insert returning rows in the order
      // they were sent.
      const addonCost = await attachCartAddons(context.supabase, data.items, saleRowsBack);

      return { sold: ids.length, sales: saleRowsBack, ...addonCost };
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
  });

export interface PendingPaymentRow {
  id: string; // sale id
  product_id: string | null;
  product_name: string;
  sku: string;
  image_url: string | null;
  created_at: string;
  selling_price: number;
  net_payment: number;
  pending_payment: number;
  payment_status: string;
  customer_name: string | null;
  customer_contact: string | null;
}

// Shared input for server-side paginated + searchable list endpoints.
// `from` is an epoch-ms lower bound on created_at (0 = all time); computed on the
// client so day/week/month boundaries follow the user's local timezone.
const pageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(10),
  search: z.string().max(200).optional().default(""),
  from: z.number().min(0).optional().default(0),
};

// Build a PostgREST `.or()` ilike filter across columns, or null if the term is
// empty. Strips characters that have meaning in the or-filter grammar so user
// input can't break the query.
function ilikeOrFilter(cols: string[], term: string): string | null {
  const safe = term.replace(/[%,().*]/g, " ").trim();
  if (!safe) return null;
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}

export interface PagedPending {
  rows: PendingPaymentRow[];
  total: number;
  outstanding: number;
  received: number;
}

// One page of sales that still owe money (pending_payment > 0), plus the totals
// across the whole filtered set (so KPI cards stay accurate while the table is
// paged). Scoped by sales.user_id so records survive product deletion. Product
// name/sku/image come from the live product when it still exists, otherwise from
// the snapshot stored on the sale — deleting a product never drops a pending row.
export const listPendingPayments = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedPending> => {
    const { page, pageSize, search } = data;
    const or = ilikeOrFilter(
      ["product_name", "product_sku", "customer_name", "customer_contact"],
      search,
    );

    type PendingSel = {
      id: string;
      product_id: string | null;
      product_name: string | null;
      product_sku: string | null;
      product_image_url: string | null;
      selling_price: number;
      net_payment: number;
      pending_payment: number;
      payment_status: string;
      customer_name: string | null;
      customer_contact: string | null;
      created_at: string;
    };

    const offset = (page - 1) * pageSize;

    // page rows, filtered-set aggregate, and the product map are all independent
    let pq = context.supabase
      .from("sales")
      .select(
        "id, product_id, product_name, product_sku, product_image_url, selling_price, net_payment, pending_payment, payment_status, customer_name, customer_contact, created_at",
        { count: "exact" },
      )
      .eq("org_id", context.orgId)
      .gt("pending_payment", 0);
    if (or) pq = pq.or(or);
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    let aq = context.supabase
      .from("sales")
      .select("net_payment, pending_payment")
      .eq("org_id", context.orgId)
      .gt("pending_payment", 0);
    if (or) aq = aq.or(or);

    const [prodRes, pageRes, aggRes] = await Promise.all([
      context.supabase.from("products").select("id, name, sku, image_url"),
      pq,
      aq,
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    const prodById = new Map<string, { name: string; sku: string; image_url: string | null }>();
    for (const p of prodRes.data ?? []) {
      prodById.set(p.id, { name: p.name, sku: p.sku, image_url: p.image_url ?? null });
    }

    let rows: PendingSel[] = [];
    let total = 0;
    let outstanding = 0;
    let received = 0;
    try {
      if (pageRes.error) throw pageRes.error;
      rows = (pageRes.data ?? []) as PendingSel[];
      total = pageRes.count ?? 0;

      if (aggRes.error) throw aggRes.error;
      for (const r of aggRes.data ?? []) {
        outstanding += Number(r.pending_payment) || 0;
        received += Number(r.net_payment) || 0;
      }
    } catch (err: any) {
      const hint = missingTableMessage(err);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    const mapped = rows.map((s) => {
      // prefer the live product (fresher name/image); fall back to the snapshot
      const live = s.product_id ? prodById.get(s.product_id) : undefined;
      return {
        id: s.id,
        product_id: s.product_id,
        product_name: live?.name ?? s.product_name ?? "Deleted product",
        sku: live?.sku ?? s.product_sku ?? "—",
        image_url: live?.image_url ?? s.product_image_url ?? null,
        created_at: s.created_at,
        selling_price: Number(s.selling_price) || 0,
        net_payment: Number(s.net_payment) || 0,
        pending_payment: Number(s.pending_payment) || 0,
        payment_status: s.payment_status,
        customer_name: s.customer_name,
        customer_contact: s.customer_contact,
      };
    });

    return { rows: mapped, total, outstanding, received };
  });

export interface LedgerStats {
  count: number;
  revenue: number;
  profit: number;
  totalSpend: number;
  stillInStock: number;
}

export interface PagedLedger {
  rows: LedgerEntry[];
  total: number;
  stats: LedgerStats;
}

// One page of sale rows (newest first) for the Sales ledger, plus revenue/profit
// totals across the whole filtered set. Scoped by sales.user_id. Cost/profit come
// from the sold stock item's purchase price; live product name/sku preferred over
// the snapshot so renames show through.
export const listSalesPage = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedLedger> => {
    const { page, pageSize, search, from } = data;

    const or = ilikeOrFilter(["product_name", "product_sku"], search);
    const fromIso = from > 0 ? new Date(from).toISOString() : null;
    const offset = (page - 1) * pageSize;

    type SaleSel = {
      id: string;
      product_id: string | null;
      product_name: string | null;
      product_sku: string | null;
      stock_item_id: string | null;
      selling_price: number;
      created_at: string;
    };

    // products map, cost map, page rows, and aggregate are independent reads
    let pq = context.supabase
      .from("sales")
      .select(
        "id, product_id, product_name, product_sku, stock_item_id, selling_price, created_at",
        {
          count: "exact",
        },
      )
      .eq("org_id", context.orgId);
    if (fromIso) pq = pq.gte("created_at", fromIso);
    if (or) pq = pq.or(or);
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    // `id` is selected so the aggregate can subtract each sale's add-on cost —
    // without it the KPI profit and the per-row profit would disagree.
    let aq = context.supabase
      .from("sales")
      .select("id, selling_price, stock_item_id")
      .eq("org_id", context.orgId);
    if (fromIso) aq = aq.gte("created_at", fromIso);
    if (or) aq = aq.or(or);

    const [prodRes, costRes, pageRes, aggRes, addonBySale] = await Promise.all([
      context.supabase.from("products").select("id, name, sku"),
      context.supabase.from("stock_items").select("id, purchase_price").eq("org_id", context.orgId),
      pq,
      aq,
      addonCostBySale(context.supabase, context.orgId),
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    const prodById = new Map<string, { name: string; sku: string }>();
    for (const p of prodRes.data ?? []) prodById.set(p.id, { name: p.name, sku: p.sku });

    // stock_item_id -> purchase price, for cost/profit (stock_items missing -> 0)
    const costById = new Map<string, number>();
    if (!costRes.error) {
      for (const r of costRes.data ?? []) costById.set(r.id, Number(r.purchase_price) || 0);
    }

    let pageRows: SaleSel[] = [];
    let total = 0;
    let revenue = 0;
    let profit = 0;
    try {
      if (pageRes.error) throw pageRes.error;
      pageRows = (pageRes.data ?? []) as SaleSel[];
      total = pageRes.count ?? 0;

      // revenue + profit across the whole filtered set. Revenue is untouched by
      // add-ons — they are given away free — but profit is net of them.
      if (aggRes.error) throw aggRes.error;
      for (const s of aggRes.data ?? []) {
        const selling = Number(s.selling_price) || 0;
        const cost = s.stock_item_id ? (costById.get(s.stock_item_id) ?? 0) : 0;
        const addon = addonBySale.get(s.id)?.cost ?? 0;
        revenue += selling;
        profit += selling - cost - addon;
      }
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    // Employees may see the sales ledger but not cost or profit (same rule that
    // keeps them off Purchases/Reports). Zero those fields for them here, so the
    // numbers are absent from the network response, not merely hidden by CSS.
    const hideCost = context.role !== "admin";

    const rows: LedgerEntry[] = pageRows.map((s) => {
      const live = s.product_id ? prodById.get(s.product_id) : undefined;
      const selling = Number(s.selling_price) || 0;
      const cost = hideCost ? 0 : s.stock_item_id ? (costById.get(s.stock_item_id) ?? 0) : 0;
      const addon = addonBySale.get(s.id);
      const addonCost = hideCost ? 0 : (addon?.cost ?? 0);
      return {
        id: s.id,
        kind: "sale",
        date: s.created_at,
        product_id: s.product_id ?? "",
        product_name: live?.name ?? s.product_name ?? "Deleted product",
        sku: live?.sku ?? s.product_sku ?? "—",
        reference: s.stock_item_id ?? "—",
        amount: selling,
        cost,
        profit: hideCost ? 0 : selling - cost - addonCost,
        sold: true,
        addon_cost: addonCost,
        // The unit count is not a cost, so an employee may see it — it tells
        // them what was handed over without revealing what it was worth.
        addon_units: addon?.units ?? 0,
      };
    });

    return {
      rows,
      total,
      stats: {
        count: total,
        revenue,
        profit: hideCost ? 0 : profit,
        totalSpend: 0,
        stillInStock: 0,
      },
    };
  });

// Full detail for a single sale, used by the Sales ledger detail drawer. Scoped by
// sales.user_id. Live product name/sku/image preferred over the snapshot; cost +
// manufacture id pulled from the sold stock item (0/null if it's gone).
export interface SaleDetail {
  id: string;
  product_id: string | null;
  product_name: string;
  sku: string;
  image_url: string | null;
  created_at: string;
  selling_price: number;
  net_payment: number;
  pending_payment: number;
  payment_status: string;
  customer_name: string | null;
  customer_contact: string | null;
  stock_item_id: string | null;
  manufacture_id: string | null;
  cost: number;
  /** What the free add-ons on this sale cost the org. Already subtracted from
   *  `profit`; carried separately so the drawer can show the deduction. */
  addon_cost: number;
  addon_units: number;
  profit: number;
}

export const getSaleDetail = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object({ id: z.string().min(1) }).parse(d))
  .handler(async ({ context, data }): Promise<SaleDetail> => {
    let sale: any;
    try {
      const res = await context.supabase
        .from("sales")
        .select(
          "id, product_id, product_name, product_sku, product_image_url, stock_item_id, selling_price, net_payment, pending_payment, payment_status, customer_name, customer_contact, created_at",
        )
        .eq("org_id", context.orgId)
        .eq("id", data.id)
        .single();
      if (res.error) throw res.error;
      sale = res.data;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    // the live product, the sold stock unit and this sale's add-on total are
    // independent lookups — run them together rather than back to back.
    const [prodRes, stockRes, addonRes] = await Promise.all([
      sale.product_id
        ? context.supabase
            .from("products")
            .select("name, sku, image_url")
            .eq("id", sale.product_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
      sale.stock_item_id
        ? context.supabase
            .from("stock_items")
            .select("purchase_price, manufacture_id")
            .eq("id", sale.stock_item_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
      context.supabase
        .from("sale_addon_totals")
        .select("addon_cost, addon_units")
        .eq("sale_id", data.id)
        .eq("org_id", context.orgId)
        .maybeSingle(),
    ]);

    // live product (fresher name/sku/image) preferred over the snapshot
    let live: { name: string; sku: string; image_url: string | null } | undefined;
    if (!prodRes.error && prodRes.data) {
      live = {
        name: prodRes.data.name,
        sku: prodRes.data.sku,
        image_url: prodRes.data.image_url ?? null,
      };
    }

    // cost + manufacture id from the sold stock unit. Withheld from employees,
    // who are not shown cost or profit anywhere.
    const hideCost = context.role !== "admin";
    let cost = 0;
    let manufacture_id: string | null = null;
    if (!hideCost && !stockRes.error && stockRes.data) {
      cost = Number(stockRes.data.purchase_price) || 0;
      manufacture_id = stockRes.data.manufacture_id ?? null;
    }

    // What the giveaways on this sale cost. A missing view (migration not run
    // yet) simply means no add-ons, which is the correct answer then.
    const addonCost =
      hideCost || addonRes.error ? 0 : Number((addonRes.data as any)?.addon_cost) || 0;
    const addonUnits = addonRes.error ? 0 : Number((addonRes.data as any)?.addon_units) || 0;

    const selling = Number(sale.selling_price) || 0;
    return {
      id: sale.id,
      product_id: sale.product_id,
      product_name: live?.name ?? sale.product_name ?? "Deleted product",
      sku: live?.sku ?? sale.product_sku ?? "—",
      image_url: live?.image_url ?? sale.product_image_url ?? null,
      created_at: sale.created_at,
      selling_price: selling,
      net_payment: Number(sale.net_payment) || 0,
      pending_payment: Number(sale.pending_payment) || 0,
      payment_status: sale.payment_status,
      customer_name: sale.customer_name,
      customer_contact: sale.customer_contact,
      stock_item_id: sale.stock_item_id,
      manufacture_id,
      cost,
      addon_cost: addonCost,
      addon_units: addonUnits,
      profit: hideCost ? 0 : selling - cost - addonCost,
    };
  });

/**
 * One page of purchase rows (newest first) for the Purchases ledger, plus spend
 * and in-stock totals across the whole filtered set. Admin-only: this is
 * purchase cost, and cost is what makes margin derivable.
 *
 * Two streams feed it, and they are shaped differently on purpose:
 *
 *   machinery — one row per UNIT, from stock_items. Each unit has a serial
 *               (its manufacture id) and its own purchase price.
 *   add-on    — one row per BATCH, from addon_stock_batches. Add-ons are bulk
 *               consumables with no serial, so a lot of 50 blades is one row
 *               with a batch code, not fifty.
 *
 * They are merged, sorted and paged HERE rather than in Postgres, because a
 * single SQL window across two tables with different shapes would need a UNION
 * whose columns lie about one side or the other. The handler was already
 * reading the whole filtered set for its aggregates, so this does not change
 * the amount of data it touches — only which columns come back.
 */
export const listPurchasesPage = createServerFn({ method: "GET" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        ...pageInput,
        stream: z.enum(["all", "machinery", "addon"]).optional().default("all"),
      })
      .parse(d),
  )
  .handler(async ({ context, data }): Promise<PagedLedger> => {
    const { page, pageSize, search, from, stream } = data;

    const or = ilikeOrFilter(["product_name", "product_sku", "manufacture_id"], search);
    const addonOr = ilikeOrFilter(["addon_name", "addon_code", "batch_code"], search);
    const fromIso = from > 0 ? new Date(from).toISOString() : null;
    const offset = (page - 1) * pageSize;

    type StockSel = {
      id: string;
      product_id: string | null;
      product_name: string | null;
      product_sku: string | null;
      manufacture_id: string | null;
      purchase_price: number;
      sold: boolean;
      created_at: string;
      order_id: string | null;
    };
    type BatchSel = {
      id: string;
      addon_id: string | null;
      addon_name: string | null;
      addon_code: string | null;
      batch_code: string;
      quantity: number;
      remaining: number;
      unit_cost: number;
      created_at: string;
      order_id: string | null;
    };

    let mq: any = context.supabase
      .from("stock_items")
      .select(
        "id, product_id, product_name, product_sku, manufacture_id, purchase_price, sold, created_at, order_id",
      )
      .eq("org_id", context.orgId);
    if (fromIso) mq = mq.gte("created_at", fromIso);
    if (or) mq = mq.or(or);
    mq = mq.order("created_at", { ascending: false });

    let bq: any = context.supabase
      .from("addon_stock_batches")
      .select(
        "id, addon_id, addon_name, addon_code, batch_code, quantity, remaining, unit_cost, created_at, order_id",
      )
      .eq("org_id", context.orgId);
    if (fromIso) bq = bq.gte("created_at", fromIso);
    if (addonOr) bq = bq.or(addonOr);
    bq = bq.order("created_at", { ascending: false });

    const [prodRes, stockRes, batchRes] = await Promise.all([
      context.supabase.from("products").select("id, name, sku"),
      stream === "addon" ? Promise.resolve({ data: [], error: null } as const) : mq,
      stream === "machinery" ? Promise.resolve({ data: [], error: null } as const) : bq,
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    const prodById = new Map<string, { name: string; sku: string }>();
    for (const p of prodRes.data ?? []) prodById.set(p.id, { name: p.name, sku: p.sku });

    if (stockRes.error) {
      const hint = missingTableMessage(stockRes.error, true);
      throw new Error(hint ?? stockRes.error.message);
    }
    // A deploy that has not run the add-on migration yet keeps a working
    // Purchases page — it just has no add-on rows to show.
    const batches: BatchSel[] = batchRes.error ? [] : ((batchRes.data ?? []) as BatchSel[]);

    const machineryRows: LedgerEntry[] = ((stockRes.data ?? []) as StockSel[]).map((it) => {
      const live = it.product_id ? prodById.get(it.product_id) : undefined;
      return {
        id: it.id,
        kind: "purchase",
        date: it.created_at,
        product_id: it.product_id ?? "",
        product_name: live?.name ?? it.product_name ?? "Deleted product",
        sku: live?.sku ?? it.product_sku ?? "—",
        reference: it.manufacture_id ?? "—",
        amount: Number(it.purchase_price) || 0,
        cost: 0,
        profit: 0,
        sold: Boolean(it.sold),
        order_id: it.order_id,
        stream: "machinery",
        quantity: 1,
      };
    });

    const addonRows: LedgerEntry[] = batches.map((b) => {
      const qty = Number(b.quantity) || 0;
      const unit = Number(b.unit_cost) || 0;
      return {
        id: b.id,
        kind: "purchase",
        date: b.created_at,
        product_id: b.addon_id ?? "",
        product_name: b.addon_name ?? "Deleted add-on",
        sku: b.addon_code ?? "—",
        reference: b.batch_code,
        // The line total, not the per-unit price: a batch IS the line. The unit
        // price is recoverable as amount / quantity, and the UI shows both.
        amount: qty * unit,
        cost: unit,
        profit: 0,
        // "Sold" for a batch means every unit in it has been given away.
        sold: (Number(b.remaining) || 0) === 0,
        order_id: b.order_id,
        stream: "addon",
        quantity: qty,
      };
    });

    // Merge, newest first. Ties break on id so the order is stable across pages
    // rather than shuffling two rows that share a timestamp.
    const merged = [...machineryRows, ...addonRows].sort((a, b) => {
      const d = new Date(b.date).getTime() - new Date(a.date).getTime();
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });

    const total = merged.length;
    let totalSpend = 0;
    let stillInStock = 0;
    for (const r of merged) {
      totalSpend += r.amount;
      // Units still on the shelf: unsold machines, plus whatever is left of an
      // add-on batch.
      if (r.stream === "addon") {
        const b = batches.find((x) => x.id === r.id);
        stillInStock += Number(b?.remaining) || 0;
      } else if (!r.sold) {
        stillInStock += 1;
      }
    }

    const rows = merged.slice(offset, offset + pageSize);

    // Receipt photos hang off the order, not the unit — and one order can carry
    // machines and add-ons under the same receipt. Only the orders on this page
    // are looked up, so the extra round trip is bounded by pageSize.
    const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))] as string[];
    if (orderIds.length) {
      const res = await context.supabase
        .from("stock_orders")
        .select("id, receipt_path")
        .in("id", orderIds)
        .eq("org_id", context.orgId);
      // A missing stock_orders table only costs the receipt link, not the page.
      if (!res.error) {
        const receiptByOrder = new Map<string, string | null>();
        for (const o of res.data ?? []) receiptByOrder.set(o.id, o.receipt_path ?? null);
        for (const r of rows) {
          r.receipt_path = r.order_id ? (receiptByOrder.get(r.order_id) ?? null) : null;
        }
      }
    }

    return {
      rows,
      total,
      stats: { count: total, revenue: 0, profit: 0, totalSpend, stillInStock },
    };
  });

// Settle (fully or partially) a pending payment. Updates net_payment and
// recomputes status; pending_payment is a generated column so it stays accurate.
// Net payment is validated to never exceed the sale's selling price.
export const settlePayment = createServerFn({ method: "POST" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) =>
    z.object({ saleId: z.string().uuid(), net_payment: z.number().min(0) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    // load the sale to validate against its selling price
    let sale: { id: string; selling_price: number } | null = null;
    try {
      const res = await context.supabase
        .from("sales")
        .select("id, selling_price")
        .eq("id", data.saleId)
        .eq("org_id", context.orgId)
        .maybeSingle();
      if (res.error) throw res.error;
      sale = (res.data as { id: string; selling_price: number } | null) ?? null;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
    if (!sale) throw new Error("Sale not found");

    const selling = Number(sale.selling_price) || 0;
    if (data.net_payment > selling) {
      throw new Error("Net payment cannot exceed the selling price");
    }
    const status = selling - data.net_payment > 0 ? "pending" : "completed";

    const { data: updated, error } = await context.supabase
      .from("sales")
      .update({ net_payment: data.net_payment, payment_status: status })
      .eq("id", data.saleId)
      .eq("org_id", context.orgId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return updated as unknown as SaleRow;
  });
