import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "./auth-middleware";

export type OrgRole = "admin" | "employee";

/**
 * Resolves the caller's organization membership on top of requireSupabaseAuth.
 *
 * Every handler that touches products / stock_items / sales uses this instead of
 * requireSupabaseAuth directly: `context.orgId` is the tenant key those tables
 * are scoped by, and `context.userId` degrades to an audit stamp ("who did it").
 *
 * The membership row is read through the caller's own RLS-bound client, so a
 * user can only ever resolve their own membership.
 */
export const requireOrgMember = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const { data, error } = await context.supabase
      .from("organization_members")
      .select("id, org_id, role, status")
      .eq("user_id", context.userId)
      .eq("status", "active")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      // handle_new_user() gives every signup an org, so this means an invite was
      // never claimed or the membership was revoked mid-session.
      throw new Error("Forbidden: you do not belong to an organization");
    }

    return next({
      context: {
        orgId: data.org_id as string,
        role: data.role as OrgRole,
        membershipId: data.id as string,
      },
    });
  });

/**
 * Same, but refuses anyone who is not an admin of their organization.
 *
 * This is the server-side half of the "employees cannot add stock or products"
 * rule. Hiding the buttons is cosmetic — an employee can still POST to a server
 * function by hand, so the ones that create, edit or delete products and stock
 * are mounted on this middleware. RLS is the third and final backstop.
 */
export const requireOrgAdmin = createMiddleware({ type: "function" })
  .middleware([requireOrgMember])
  .server(async ({ next, context }) => {
    if (context.role !== "admin") {
      throw new Error("Forbidden: this action requires an admin role");
    }
    return next();
  });
