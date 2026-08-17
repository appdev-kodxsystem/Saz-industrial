import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOrgAdmin, requireOrgMember } from "@/integrations/supabase/org-middleware";
import type { Tables } from "@/integrations/supabase/types";

// Add-ons — free extras handed out with a sold machine, paid for out of margin.
//
// Three rules define the feature, and all three live in the database rather than
// here (see supabase/migrations/20260817120000_addons.sql):
//
//   1. An add-on never changes what the customer pays. Nothing in this file
//      writes selling_price, net_payment or pending_payment.
//   2. What it cost the org is subtracted from the PROFIT of the sale it went
//      out on — sale_addons.total_cost, rolled up by the sale_addon_totals view.
//   3. An add-on cannot be sold on its own. sale_addons.sale_id is NOT NULL and
//      `authenticated` has no INSERT grant on that table, so the only way to
//      consume add-on stock is the addon_attach_to_sale() RPC, which refuses to
//      run unless the sale already exists in the caller's organization.
//
// Same middleware split as inventory.functions.ts: requireOrgMember for reads
// and the sell path, requireOrgAdmin for anything that creates, edits or
// receives stock. RLS enforces the same split independently.

/** Catalogue row joined with its derived stock level. */
export interface AddonRow {
  id: string;
  org_id: string;
  // Audit stamp: which member last wrote the row. Goes NULL if that person is
  // removed — the catalogue belongs to the organization, not to them.
  user_id: string | null;
  name: string;
  code: string;
  category: string;
  description: string | null;
  image_url: string | null;
  unit_cost: number;
  /** What it's worth to the customer, for the receipt line. Never charged. */
  list_value: number;
  reorder_at: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  // from addon_stock_levels — derived from the batches, so it cannot drift
  on_hand: number;
  received: number;
  given_away: number;
  on_hand_value: number;
  total_spend: number;
}

export interface AddonBatchRow {
  id: string;
  addon_id: string | null;
  addon_name: string | null;
  addon_code: string | null;
  batch_code: string;
  quantity: number;
  remaining: number;
  unit_cost: number;
  order_id: string | null;
  created_at: string;
}

export interface SaleAddonRow {
  id: string;
  sale_id: string;
  addon_id: string | null;
  addon_name: string | null;
  addon_code: string | null;
  addon_image_url: string | null;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  list_value: number;
  created_at: string;
}

// If `err` is a Postgres "relation does not exist" error for one of the add-on
// tables, return an actionable migration hint; otherwise null. The add-on
// migration is the newest one, so a deploy that has not run it yet is the single
// most likely cause of a failure on these pages.
export function missingAddonTableMessage(err: unknown): string | null {
  const msg = String((err as { message?: unknown })?.message ?? err);
  for (const rel of [
    "addons",
    "addon_stock_batches",
    "sale_addons",
    "addon_stock_levels",
    "sale_addon_totals",
  ] as const) {
    if (msg.includes(`Could not find the table 'public.${rel}'`)) {
      return `Missing DB relation '${rel}'. Run supabase/schema.sql (or the migration in supabase/migrations) and redeploy.`;
    }
  }
  return null;
}

const addonInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(80),
  category: z.string().min(1).max(80),
  description: z.string().max(2000).nullable().optional(),
  image_url: z.string().nullable().optional(),
  unit_cost: z.number().min(0).max(1_000_000),
  list_value: z.number().min(0).max(1_000_000),
  reorder_at: z.number().int().min(0).max(1_000_000),
  active: z.boolean(),
});

/**
 * The add-on catalogue, each row carrying its derived on-hand stock.
 *
 * Every member reads this — an employee needs it to know what they can promise
 * at the counter — but cost is admin-only, exactly as it is for products. The
 * cost fields are zeroed in the payload rather than merely hidden in the UI, so
 * they never reach an employee's browser.
 */
export const listAddons = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .handler(async ({ context }): Promise<AddonRow[]> => {
    // The catalogue and the stock levels are independent reads — fire them
    // together rather than back to back.
    const [addonRes, levelRes] = await Promise.all([
      context.supabase
        .from("addons")
        .select("*")
        .eq("org_id", context.orgId)
        .order("active", { ascending: false })
        .order("name", { ascending: true }),
      context.supabase.from("addon_stock_levels").select("*").eq("org_id", context.orgId),
    ]);

    if (addonRes.error) {
      const hint = missingAddonTableMessage(addonRes.error);
      throw new Error(hint ?? addonRes.error.message);
    }

    // A missing or failed levels read costs the stock numbers, not the page.
    const levelById = new Map<string, Tables<"addon_stock_levels">>();
    if (!levelRes.error) {
      for (const l of levelRes.data ?? []) levelById.set(l.addon_id, l);
    }

    const hideCost = context.role !== "admin";

    return (addonRes.data ?? []).map((a) => {
      const lvl = levelById.get(a.id);
      return {
        ...a,
        unit_cost: hideCost ? 0 : Number(a.unit_cost) || 0,
        list_value: Number(a.list_value) || 0,
        on_hand: Number(lvl?.on_hand) || 0,
        received: Number(lvl?.received) || 0,
        given_away: Number(lvl?.given_away) || 0,
        on_hand_value: hideCost ? 0 : Number(lvl?.on_hand_value) || 0,
        total_spend: hideCost ? 0 : Number(lvl?.total_spend) || 0,
      } as AddonRow;
    });
  });

export const upsertAddon = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => addonInput.parse(d))
  .handler(async ({ context, data }) => {
    // org_id is the tenant key; user_id records which admin last wrote the row.
    // The update is additionally pinned to the caller's org, so a guessed id
    // from another tenant matches nothing.
    const payload = { ...data, org_id: context.orgId, user_id: context.userId };
    const { data: row, error } = data.id
      ? await context.supabase
          .from("addons")
          .update(payload)
          .eq("id", data.id)
          .eq("org_id", context.orgId)
          .select()
          .single()
      : await context.supabase.from("addons").insert(payload).select().single();

    if (error) {
      const hint = missingAddonTableMessage(error);
      // The unique index on (org_id, lower(code)) is what stops two admins
      // quietly creating two "TK-01"s that later read as the same thing.
      if (error.code === "23505") {
        throw new Error(`An add-on with code "${data.code}" already exists`);
      }
      throw new Error(hint ?? error.message);
    }
    return row as unknown as AddonRow;
  });

/**
 * Retire or delete an add-on.
 *
 * Deleting is safe for history: addon_stock_batches.addon_id and
 * sale_addons.addon_id are both ON DELETE SET NULL and carry name/code
 * snapshots, so past purchases and past giveaways survive intact.
 */
export const deleteAddon = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("addons")
      .delete()
      .eq("id", data.id)
      .eq("org_id", context.orgId);
    if (error) throw new Error(missingAddonTableMessage(error) ?? error.message);
    return { ok: true };
  });

/** Flip `active`. A retired add-on stays on old sales but drops out of the
 *  sell-time picker — the usual way to take something out of circulation
 *  without erasing what it cost you. */
export const setAddonActive = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("addons")
      .update({ active: data.active })
      .eq("id", data.id)
      .eq("org_id", context.orgId);
    if (error) throw new Error(missingAddonTableMessage(error) ?? error.message);
    return { ok: true };
  });

/** Every batch received for one add-on, newest first. Admin-only: it is nothing
 *  but purchase cost. */
export const listAddonBatches = createServerFn({ method: "GET" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ addonId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }): Promise<AddonBatchRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("addon_stock_batches")
      .select(
        "id, addon_id, addon_name, addon_code, batch_code, quantity, remaining, unit_cost, order_id, created_at",
      )
      .eq("addon_id", data.addonId)
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(missingAddonTableMessage(error) ?? error.message);
    // Postgres NUMERIC comes back as a string over PostgREST, so coerce rather
    // than trusting the declared type.
    return (rows ?? []).map((r) => ({
      ...r,
      quantity: Number(r.quantity) || 0,
      remaining: Number(r.remaining) || 0,
      unit_cost: Number(r.unit_cost) || 0,
    }));
  });

/**
 * The add-ons that went out with one sale, for the sale detail drawer.
 *
 * Any member may read this — an employee should be able to see what was handed
 * over — but cost is blanked for them, so the drawer shows the giveaway without
 * revealing the margin it came out of.
 */
export const getSaleAddons = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .inputValidator((d: unknown) => z.object({ saleId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }): Promise<SaleAddonRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("sale_addons")
      .select("*")
      .eq("sale_id", data.saleId)
      .eq("org_id", context.orgId)
      .order("created_at", { ascending: true });

    if (error) {
      // A deploy that has not run the migration yet should not break the whole
      // sale drawer — it just has no add-ons to show.
      if (missingAddonTableMessage(error)) return [];
      throw new Error(error.message);
    }

    const hideCost = context.role !== "admin";
    return (rows ?? []).map((r) => ({
      id: r.id,
      sale_id: r.sale_id,
      addon_id: r.addon_id,
      addon_name: r.addon_name,
      addon_code: r.addon_code,
      addon_image_url: r.addon_image_url,
      quantity: Number(r.quantity) || 0,
      unit_cost: hideCost ? 0 : Number(r.unit_cost) || 0,
      total_cost: hideCost ? 0 : Number(r.total_cost) || 0,
      list_value: Number(r.list_value) || 0,
      created_at: r.created_at,
    }));
  });

/**
 * Take an add-on back off a sale.
 *
 * Admin-only, because it rewrites the profit of a sale that already happened.
 * The units go back on the shelf by way of the AFTER DELETE trigger on
 * sale_addons, clamped at the batch's original quantity so a double restore can
 * never inflate stock.
 */
export const removeSaleAddon = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("sale_addons")
      .delete()
      .eq("id", data.id)
      .eq("org_id", context.orgId);
    if (error) throw new Error(missingAddonTableMessage(error) ?? error.message);
    return { ok: true };
  });
