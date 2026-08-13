import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "./auth-middleware";

export type OrgRole = "admin" | "employee";

type Membership = { orgId: string; role: OrgRole; membershipId: string };

/**
 * Short-lived cache of the caller's membership row, keyed by user id.
 *
 * This lookup sat in front of EVERY data-touching server function, so a single
 * page load paid for it once per query — each one a separate sequential round
 * trip to Postgres before the query the page actually wanted could start.
 * Membership changes about once a month; re-reading it several times a second
 * was the single most repeated query in the app.
 *
 * The TTL is deliberately short. A role change or a revoked membership takes
 * effect within TTL_MS here, and the layers underneath it are unaffected: RLS
 * still scopes every row read to the caller, and the membership writes all go
 * through SECURITY DEFINER functions that re-derive admin status in the database
 * from the caller's JWT. So a stale `role` cannot authorise a write the database
 * would refuse — at worst a just-demoted admin sees admin UI for a few seconds.
 */
const TTL_MS = 15_000;
const MAX_ENTRIES = 500;

const membershipCache = new Map<string, { value: Membership; expiresAt: number }>();

function pruneMembershipCache(now: number) {
  for (const [key, entry] of membershipCache) {
    if (entry.expiresAt <= now) membershipCache.delete(key);
  }
  while (membershipCache.size > MAX_ENTRIES) {
    const oldest = membershipCache.keys().next();
    if (oldest.done) break;
    membershipCache.delete(oldest.value);
  }
}

/**
 * Drop a user's cached membership so the next request re-reads it.
 *
 * Call this from any handler that changes membership (role updates, removals,
 * invite claims) so the change is visible immediately instead of after the TTL.
 */
export function invalidateMembership(userId: string) {
  membershipCache.delete(userId);
}

/**
 * Drop every cached membership.
 *
 * Membership mutations identify people by membership-row id, not user id, so
 * there is no cheap way to target one entry. These mutations are rare (a role
 * change, an invite, a removal) and the cache refills on the next request, so
 * clearing all of it is the simpler correct thing.
 */
export function invalidateAllMemberships() {
  membershipCache.clear();
}

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
    const now = Date.now();
    const cached = membershipCache.get(context.userId);
    if (cached && cached.expiresAt > now) {
      return next({ context: cached.value });
    }

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
      membershipCache.delete(context.userId);
      throw new Error("Forbidden: you do not belong to an organization");
    }

    const membership: Membership = {
      orgId: data.org_id as string,
      role: data.role as OrgRole,
      membershipId: data.id as string,
    };

    membershipCache.set(context.userId, { value: membership, expiresAt: now + TTL_MS });
    pruneMembershipCache(now);

    return next({ context: membership });
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
