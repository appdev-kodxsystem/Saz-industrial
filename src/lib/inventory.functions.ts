import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tables } from "@/integrations/supabase/types";

type StockItemRow = Tables<"stock_items">;
type SaleRow = Tables<"sales">;

export interface ProductRow {
  id: string;
  user_id: string;
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
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("products")
      .select("*")
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as ProductRow[];
  });

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => productInput.parse(data))
  .handler(async ({ context, data }) => {
    const payload = { ...data, user_id: context.userId };
    const { data: row, error } = data.id
      ? await context.supabase
          .from("products")
          .update(payload)
          .eq("id", data.id)
          .select()
          .single()
      : await context.supabase.from("products").insert(payload).select().single();
    if (error) throw new Error(error.message);
    return row as unknown as ProductRow;
  });

export const adjustStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), delta: z.number().int().min(-10000).max(10000) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { data: current, error: e1 } = await context.supabase
      .from("products")
      .select("stock")
      .eq("id", data.id)
      .single();
    if (e1) throw new Error(e1.message);
    const next = Math.max(0, ((current?.stock as number) ?? 0) + data.delta);
    const { data: row, error } = await context.supabase
      .from("products")
      .update({ stock: next })
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as ProductRow;
  });

export const togglePin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), pinned: z.boolean() }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("products")
      .update({ pinned: data.pinned })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: src, error: e1 } = await context.supabase
      .from("products")
      .select("*")
      .eq("id", data.id)
      .single<ProductRow>();
    if (e1 || !src) throw new Error(e1?.message ?? "Not found");
    const copy = {
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
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("products").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const DEMO = [
  {
    name: "Apex Mitre Saw Pro X1", sku: "MS-402-B", category: "Power Tools",
    description: "Industrial-grade mitre saw with dual-bevel and integrated laser guide.",
    stock: 48, reorder_at: 10, purchase_price: 312, selling_price: 499,
  },
  {
    name: "Isotope Torque Wrench", sku: "TW-99", category: "Hand Tools",
    description: "Calibrated click-style torque wrench with locking collar.",
    stock: 4, reorder_at: 8, purchase_price: 62, selling_price: 124.5,
  },
  {
    name: "Carbon Digital Calipers", sku: "CC-01", category: "Precision Instruments",
    description: "0-150mm carbon-fiber calipers with 0.01mm resolution.",
    stock: 22, reorder_at: 6, purchase_price: 28, selling_price: 59,
  },
  {
    name: "Helius Safety Goggles", sku: "HG-05", category: "Safety Equipment",
    description: "ANSI Z87.1+ rated clear polycarbonate goggles.",
    stock: 132, reorder_at: 20, purchase_price: 6, selling_price: 18,
  },
  {
    name: "Flux Soldering Station", sku: "SX-200", category: "Electronics",
    description: "60W digital soldering station, ESD-safe ceramic heater.",
    stock: 9, reorder_at: 10, purchase_price: 84, selling_price: 169,
  },
  {
    name: "Neon Laser Level", sku: "LL-12", category: "Precision Instruments",
    description: "Self-leveling green-beam cross-line laser, IP65.",
    stock: 17, reorder_at: 5, purchase_price: 110, selling_price: 229,
  },
];

export const seedDemoProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const rows = DEMO.map((p) => ({ ...p, user_id: context.userId, image_url: null, pinned: false }));
    const { error } = await context.supabase.from("products").insert(rows);
    if (error) throw new Error(error.message);
    return { inserted: rows.length };
  });

// If `err` is a Postgres "relation does not exist" error for a known table,
// returns an actionable migration hint; otherwise null. Callers keep their own
// fallback so non-table errors propagate exactly as before.
function missingTableMessage(err: unknown, withOriginal = false): string | null {
  const msg = String((err as { message?: unknown })?.message ?? err);
  for (const table of ["stock_items", "sales"] as const) {
    if (msg.includes(`Could not find the table 'public.${table}'`)) {
      const base = `Missing DB table '${table}'. Run the migrations (see supabase/migrations) and redeploy or run \`supabase db push\`.`;
      return withOriginal ? `${base}\nOriginal: ${msg}` : base;
    }
  }
  return null;
}

// Stock item management: add individual stock entries, peek next available, and sell one
const stockEntry = z.object({ manufacture_id: z.string().min(1).max(200), purchase_price: z.number().min(0).max(1_000_000) });

export const addStockEntries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ productId: z.string().uuid(), entries: z.array(stockEntry).min(1) }).parse(d))
  .handler(async ({ context, data }) => {
    // snapshot product info + user_id so purchase history survives product deletion
    const snap = await fetchProductSnapshot(context.supabase, data.productId);
    const rows = data.entries.map((e) => ({
      product_id: data.productId,
      user_id: context.userId,
      product_name: snap.name,
      product_sku: snap.sku,
      product_image_url: snap.image_url,
      manufacture_id: e.manufacture_id,
      purchase_price: e.purchase_price,
    }));
    let inserted: StockItemRow[] | null = null;
    try {
      const res = await context.supabase.from("stock_items").insert(rows).select();
      inserted = res.data;
      if (res.error) throw res.error;
    } catch (err: any) {
      const hint = missingTableMessage(err);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }
    // increment product stock by reading current value then updating
    const { data: currentProd, error: e2 } = await context.supabase
      .from("products")
      .select("stock")
      .eq("id", data.productId)
      .single();
    if (e2) throw new Error(e2.message);
    const nextStock = Math.max(0, ((currentProd?.stock as number) ?? 0) + rows.length);
    const { data: prod, error: e3 } = await context.supabase
      .from("products")
      .update({ stock: nextStock })
      .eq("id", data.productId)
      .select()
      .single();
    if (e3) throw new Error(e3.message);
    return { inserted: inserted ?? [] };
  });

export const peekNextStockItem = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
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
    // snapshot so the sale + any pending payment survive product deletion
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

export const sellOneFromStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ productId: z.string().uuid(), ...salePaymentInput }).parse(d))
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

    // decrement product stock by reading current value then updating
    const { data: currentProd, error: e4 } = await context.supabase
      .from("products")
      .select("stock")
      .eq("id", data.productId)
      .single();
    if (e4) throw new Error(e4.message);
    const nextStockDec = Math.max(0, ((currentProd?.stock as number) ?? 0) - 1);
    const { data: prod, error: e5 } = await context.supabase
      .from("products")
      .update({ stock: nextStockDec })
      .eq("id", data.productId)
      .select()
      .single();
    if (e5) throw new Error(e5.message);

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
  profit: number; // sale only.
  sold: boolean; // purchase rows: whether that stock unit has since been sold.
}

// Unified activity ledger. Stock-in/purchase rows come from stock_items,
// stock-out/sale rows from sales. Each row carries its product name + sku.
export const getLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
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
    const [prodRes, stockRes, salesRes] = await Promise.all([
      context.supabase.from("products").select("id, name, sku"),
      context.supabase
        .from("stock_items")
        .select("id, product_id, user_id, product_name, product_sku, manufacture_id, purchase_price, sold, created_at")
        .eq("user_id", context.userId),
      context.supabase
        .from("sales")
        .select("id, product_id, user_id, product_name, product_sku, stock_item_id, selling_price, created_at")
        .eq("user_id", context.userId),
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    const prodById = new Map<string, { name: string; sku: string }>();
    for (const p of prodRes.data ?? []) prodById.set(p.id, { name: p.name, sku: p.sku });

    const entries: LedgerEntry[] = [];

    // A row belongs to the user if its product is one of theirs (original
    // scoping, works even when user_id was never backfilled), OR — once the
    // product is deleted (product_id null) — if the snapshot user_id matches.
    const ownsRow = (productId: string | null, userId: string | null) =>
      (productId != null && prodById.has(productId)) ||
      (productId == null && userId === context.userId);

    // Stock-in / purchases
    let stockItems: StockItemSel[] = [];
    if (stockRes.error) {
      if (!String(stockRes.error.message).includes("Could not find the table 'public.stock_items'")) {
        throw new Error(stockRes.error.message);
      }
    } else {
      stockItems = ((stockRes.data ?? []) as StockItemSel[]).filter((it) => ownsRow(it.product_id, it.user_id));
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
      sales = ((salesRes.data ?? []) as SaleLedgerSel[]).filter((s) => ownsRow(s.product_id, s.user_id));
    }
    for (const s of sales) {
      const p = s.product_id ? prodById.get(s.product_id) : undefined;
      const selling = Number(s.selling_price) || 0;
      const cost = s.stock_item_id ? costById.get(s.stock_item_id) ?? 0 : 0;
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
        profit: selling - cost,
        sold: true,
      });
    }

    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return entries;
  });

// Returns every sale for the user joined with its stock item's purchase price,
// so the client can bucket profit/revenue by week/month/year.
export const getProfitSeries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProfitSaleRow[]> => {
    // sales + cost map are independent — fetch in parallel (one round trip)
    const [salesRes, costRes] = await Promise.all([
      context.supabase
        .from("sales")
        .select("selling_price, created_at, stock_item_id")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true }),
      context.supabase.from("stock_items").select("id, purchase_price").eq("user_id", context.userId),
    ]);

    let sales: { selling_price: number; created_at: string; stock_item_id: string | null }[] = [];
    if (salesRes.error) {
      if (String(salesRes.error.message).includes("Could not find the table 'public.sales'")) return [];
      throw new Error(salesRes.error.message);
    }
    sales = (salesRes.data ?? []) as typeof sales;

    // Map stock_item_id -> purchase_price for cost/profit. stock_items missing -> cost 0.
    const costById = new Map<string, number>();
    if (!costRes.error) {
      for (const row of costRes.data ?? []) costById.set(row.id, Number(row.purchase_price) || 0);
    }

    return sales.map((s) => {
      const cost = s.stock_item_id ? costById.get(s.stock_item_id) ?? 0 : 0;
      const selling = Number(s.selling_price) || 0;
      return { created_at: s.created_at, selling_price: selling, cost, profit: selling - cost };
    });
  });

export const getAvailableStockItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
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
      return items ?? [];
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw err;
    }
  });

export const sellStockItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ stockItemId: z.string().uuid(), ...salePaymentInput }).parse(d))
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

      // decrement product stock by reading current value then updating
      const { data: currentProd, error: e4 } = await context.supabase
        .from("products")
        .select("stock")
        .eq("id", productId)
        .single();
      if (e4) throw new Error(e4.message);
      const nextStock = Math.max(0, ((currentProd?.stock as number) ?? 0) - 1);
      const { data: prod, error: e5 } = await context.supabase
        .from("products")
        .update({ stock: nextStock })
        .eq("id", productId)
        .select()
        .single();
      if (e5) throw new Error(e5.message);

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
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        items: z
          .array(
            z.object({
              stockItemId: z.string().uuid(),
              selling_price: z.number().min(0).optional(),
              net_payment: z.number().min(0).optional(),
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
        context.supabase.from("products").select("id, name, sku, image_url, stock").in("id", productIds),
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

      // decrement product stock by the number of units sold from each product —
      // distinct products are independent, so update them concurrently.
      const soldPerProduct = new Map<string, number>();
      for (const it of items) {
        const pid = it.product_id as string;
        soldPerProduct.set(pid, (soldPerProduct.get(pid) ?? 0) + 1);
      }
      const stockUpdates = await Promise.all(
        [...soldPerProduct].map(([pid, n]) => {
          const current = (prodById.get(pid)?.stock as number) ?? 0;
          return context.supabase
            .from("products")
            .update({ stock: Math.max(0, current - n) })
            .eq("id", pid);
        }),
      );
      const stockErr = stockUpdates.find((r) => r.error);
      if (stockErr?.error) throw new Error(stockErr.error.message);

      return { sold: ids.length, sales: salesRes.data ?? [] };
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
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedPending> => {
    const { page, pageSize, search } = data;
    const or = ilikeOrFilter(["product_name", "product_sku", "customer_name", "customer_contact"], search);

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
      .eq("user_id", context.userId)
      .gt("pending_payment", 0);
    if (or) pq = pq.or(or);
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    let aq = context.supabase
      .from("sales")
      .select("net_payment, pending_payment")
      .eq("user_id", context.userId)
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
  .middleware([requireSupabaseAuth])
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
      .select("id, product_id, product_name, product_sku, stock_item_id, selling_price, created_at", {
        count: "exact",
      })
      .eq("user_id", context.userId);
    if (fromIso) pq = pq.gte("created_at", fromIso);
    if (or) pq = pq.or(or);
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    let aq = context.supabase.from("sales").select("selling_price, stock_item_id").eq("user_id", context.userId);
    if (fromIso) aq = aq.gte("created_at", fromIso);
    if (or) aq = aq.or(or);

    const [prodRes, costRes, pageRes, aggRes] = await Promise.all([
      context.supabase.from("products").select("id, name, sku"),
      context.supabase.from("stock_items").select("id, purchase_price").eq("user_id", context.userId),
      pq,
      aq,
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

      // revenue + profit across the whole filtered set
      if (aggRes.error) throw aggRes.error;
      for (const s of aggRes.data ?? []) {
        const selling = Number(s.selling_price) || 0;
        const cost = s.stock_item_id ? costById.get(s.stock_item_id) ?? 0 : 0;
        revenue += selling;
        profit += selling - cost;
      }
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    const rows: LedgerEntry[] = pageRows.map((s) => {
      const live = s.product_id ? prodById.get(s.product_id) : undefined;
      const selling = Number(s.selling_price) || 0;
      const cost = s.stock_item_id ? costById.get(s.stock_item_id) ?? 0 : 0;
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
        profit: selling - cost,
        sold: true,
      };
    });

    return { rows, total, stats: { count: total, revenue, profit, totalSpend: 0, stillInStock: 0 } };
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
  profit: number;
}

export const getSaleDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().min(1) }).parse(d))
  .handler(async ({ context, data }): Promise<SaleDetail> => {
    let sale: any;
    try {
      const res = await context.supabase
        .from("sales")
        .select(
          "id, product_id, product_name, product_sku, product_image_url, stock_item_id, selling_price, net_payment, pending_payment, payment_status, customer_name, customer_contact, created_at",
        )
        .eq("user_id", context.userId)
        .eq("id", data.id)
        .single();
      if (res.error) throw res.error;
      sale = res.data;
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    // the live product and the sold stock unit are independent lookups — run
    // them together rather than back to back.
    const [prodRes, stockRes] = await Promise.all([
      sale.product_id
        ? context.supabase.from("products").select("name, sku, image_url").eq("id", sale.product_id).maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
      sale.stock_item_id
        ? context.supabase
            .from("stock_items")
            .select("purchase_price, manufacture_id")
            .eq("id", sale.stock_item_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
    ]);

    // live product (fresher name/sku/image) preferred over the snapshot
    let live: { name: string; sku: string; image_url: string | null } | undefined;
    if (!prodRes.error && prodRes.data) {
      live = { name: prodRes.data.name, sku: prodRes.data.sku, image_url: prodRes.data.image_url ?? null };
    }

    // cost + manufacture id from the sold stock unit
    let cost = 0;
    let manufacture_id: string | null = null;
    if (!stockRes.error && stockRes.data) {
      cost = Number(stockRes.data.purchase_price) || 0;
      manufacture_id = stockRes.data.manufacture_id ?? null;
    }

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
      profit: selling - cost,
    };
  });

// One page of purchase rows (newest first) for the Purchases ledger, plus spend +
// in-stock totals across the whole filtered set. Sourced from stock_items, scoped
// by user_id; live product name/sku preferred over the snapshot.
export const listPurchasesPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object(pageInput).parse(d))
  .handler(async ({ context, data }): Promise<PagedLedger> => {
    const { page, pageSize, search, from } = data;

    const or = ilikeOrFilter(["product_name", "product_sku", "manufacture_id"], search);
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
    };

    // products map, page rows, and the filtered-set aggregate are independent
    let pq = context.supabase
      .from("stock_items")
      .select("id, product_id, product_name, product_sku, manufacture_id, purchase_price, sold, created_at", {
        count: "exact",
      })
      .eq("user_id", context.userId);
    if (fromIso) pq = pq.gte("created_at", fromIso);
    if (or) pq = pq.or(or);
    pq = pq.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);

    let aq = context.supabase.from("stock_items").select("purchase_price, sold").eq("user_id", context.userId);
    if (fromIso) aq = aq.gte("created_at", fromIso);
    if (or) aq = aq.or(or);

    const [prodRes, pageRes, aggRes] = await Promise.all([
      context.supabase.from("products").select("id, name, sku"),
      pq,
      aq,
    ]);

    if (prodRes.error) throw new Error(prodRes.error.message);
    const prodById = new Map<string, { name: string; sku: string }>();
    for (const p of prodRes.data ?? []) prodById.set(p.id, { name: p.name, sku: p.sku });

    let pageRows: StockSel[] = [];
    let total = 0;
    let totalSpend = 0;
    let stillInStock = 0;
    try {
      if (pageRes.error) throw pageRes.error;
      pageRows = (pageRes.data ?? []) as StockSel[];
      total = pageRes.count ?? 0;

      // spend + in-stock count across the whole filtered set
      if (aggRes.error) throw aggRes.error;
      for (const r of aggRes.data ?? []) {
        totalSpend += Number(r.purchase_price) || 0;
        if (!r.sold) stillInStock += 1;
      }
    } catch (err: any) {
      const hint = missingTableMessage(err, true);
      if (hint) throw new Error(hint);
      throw new Error(err?.message || String(err));
    }

    const rows: LedgerEntry[] = pageRows.map((it) => {
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
      };
    });

    return { rows, total, stats: { count: total, revenue: 0, profit: 0, totalSpend, stillInStock } };
  });

// Settle (fully or partially) a pending payment. Updates net_payment and
// recomputes status; pending_payment is a generated column so it stays accurate.
// Net payment is validated to never exceed the sale's selling price.
export const settlePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
        .eq("user_id", context.userId)
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
      .eq("user_id", context.userId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return updated as unknown as SaleRow;
  });
