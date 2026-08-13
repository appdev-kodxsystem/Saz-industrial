import process from "node:process";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  invalidateAllMemberships,
  requireOrgAdmin,
  requireOrgMember,
} from "@/integrations/supabase/org-middleware";
import type { OrgRole } from "@/integrations/supabase/org-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Every membership write below goes through a SECURITY DEFINER function in the
// database (org_invite_member, org_update_member_role, org_remove_member, …).
// Each of those re-derives the caller's org and admin status from their JWT, so
// the rules hold even if someone calls PostgREST directly — and this server code
// never needs a key that bypasses RLS.
//
// The single exception is sending the invite email: that is Supabase's admin
// Auth API and genuinely requires the service-role key.

export interface OrgMember {
  id: string;
  user_id: string | null;
  email: string;
  role: OrgRole;
  status: "pending" | "active";
  display_name: string | null;
  avatar_url: string | null;
  /** false until the member has chosen their own password. The real "invite
   *  still outstanding" signal — `status` flips to active the moment the invite
   *  creates their auth account, long before they do anything. */
  password_set: boolean;
  /** The person who created the organization. Permanently an admin: cannot be
   *  demoted or removed, by anyone. The Team list shows no action menu for them. */
  is_owner: boolean;
  created_at: string;
}

export interface MyOrg {
  org: { id: string; name: string };
  role: OrgRole;
  membershipId: string;
  passwordSet: boolean;
  /** Whether the CALLER is the org's owner. */
  isOwner: boolean;
}

/**
 * Cache key for {@link getMyOrg}.
 *
 * The /_authenticated beforeLoad reads the org through the query client rather
 * than calling the server function directly, so that navigating between pages
 * reuses the answer instead of re-fetching it on every single route change.
 * Anything that changes the caller's own membership — notably setting a password
 * for the first time — must invalidate this key, because `router.invalidate()`
 * alone re-runs beforeLoad but does not touch the query cache.
 */
export const MY_ORG_QUERY_KEY = ["my-org"] as const;

/**
 * The caller's organization and their role in it. Read once by the
 * /_authenticated beforeLoad and handed to every page through router context.
 */
export const getMyOrg = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .handler(async ({ context }): Promise<MyOrg> => {
    const [orgRes, memberRes] = await Promise.all([
      context.supabase
        .from("organizations")
        .select("id, name, owner_id")
        .eq("id", context.orgId)
        .single(),
      context.supabase
        .from("organization_members")
        .select("password_set")
        .eq("id", context.membershipId)
        .single(),
    ]);
    if (orgRes.error) throw new Error(orgRes.error.message);
    if (memberRes.error) throw new Error(memberRes.error.message);
    return {
      org: { id: orgRes.data.id, name: orgRes.data.name },
      role: context.role,
      membershipId: context.membershipId,
      passwordSet: memberRes.data.password_set,
      isOwner: orgRes.data.owner_id === context.userId,
    };
  });

/**
 * Rename the organization. Admin-only, enforced in the database.
 *
 * Goes through an RPC rather than a plain UPDATE because RLS has no column-level
 * security: a blanket UPDATE grant on `organizations` would also have let an
 * admin PATCH `owner_id` onto themselves and seize the org. org_rename can touch
 * nothing but `name`.
 */
export const renameOrg = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ name: z.string().trim().min(1).max(120) }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.rpc("org_rename", { p_name: data.name });
    if (error) throw new Error(error.message);
    return { ok: true, name: data.name };
  });

/**
 * Called by the set-password screen once the invitee has actually chosen a
 * password. Takes no arguments — the database scopes the update to auth.uid(),
 * so it can only ever clear the flag for the caller themselves.
 */
export const markPasswordSet = createServerFn({ method: "POST" })
  .middleware([requireOrgMember])
  .handler(async ({ context }) => {
    const { error } = await context.supabase.rpc("org_mark_password_set");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Everyone in the caller's org, pending invites included. */
export const listOrgMembers = createServerFn({ method: "GET" })
  .middleware([requireOrgMember])
  .handler(async ({ context }): Promise<OrgMember[]> => {
    const { data, error } = await context.supabase.rpc("org_list_members");
    if (error) throw new Error(error.message);
    return (data ?? []) as OrgMember[];
  });

const roleInput = z.enum(["admin", "employee"]);

// Sending the invite is the one step that needs the real service-role key, so
// fail with an instruction rather than a stack trace when it isn't configured.
// The key lives in SUPABASE_SERVICE_ROLE_KEY (Supabase dashboard > Project
// Settings > API > service_role). It is NOT the same value as the publishable
// key, and it must never be given a VITE_ prefix — that would ship it to the
// browser.
async function sendInviteEmail(email: string, redirectTo: string) {
  // The single most common misconfig: SUPABASE_SERVICE_ROLE_KEY is filled in
  // with a COPY of the anon/publishable key. They're both JWTs and look alike,
  // but the anon key can't reach the admin Auth API, so the invite would fail
  // with an opaque 401. Catch the exact mistake up front with a clear message.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (serviceKey && anonKey && serviceKey === anonKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is set to your anon/publishable key (the two values are identical). " +
        "Copy the SECRET service_role key from Supabase > Project Settings > API > service_role, " +
        "put it in SUPABASE_SERVICE_ROLE_KEY only, and restart the server.",
    );
  }

  // No org/role is passed in the invite metadata on purpose. handle_new_user()
  // places the invitee by claiming the pending organization_members row this
  // org already created — it never trusts signup metadata for org or role,
  // because that metadata is client-controlled (see the trigger's comment).
  const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!error) return;

  if (/service_role|not allowed|User not allowed|403|invalid api key/i.test(error.message)) {
    throw new Error(
      "Invites are not configured: SUPABASE_SERVICE_ROLE_KEY is missing or is not a real service-role key. " +
        "Copy it from Supabase > Project Settings > API > service_role and redeploy.",
    );
  }
  if (/already been registered|already exists/i.test(error.message)) {
    throw new Error(
      "That email already has an account. They must leave their current organization before joining this one.",
    );
  }
  throw new Error(error.message);
}

/**
 * Invite someone to the org by email.
 *
 * The membership row is written FIRST, then the email is sent. That order is
 * load-bearing: inviteUserByEmail creates the auth.users row immediately, which
 * fires handle_new_user(), which looks for a pending membership matching the
 * email. Send the email first and the trigger would find nothing, fall through
 * to its self-signup branch, and hand the invitee a brand new org of their own
 * instead of a seat in this one.
 *
 * If the email then fails we withdraw the row, so a failed invite leaves no
 * ghost member in the team list.
 *
 * DELIVERY: this uses Supabase Auth's email sender, which is rate-limited to a
 * few messages an hour and is not meant for production — configure custom SMTP
 * under Authentication > Emails. The redirect target must also be listed under
 * Authentication > URL Configuration > Redirect URLs or the link will bounce.
 */
export const inviteMember = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().email().max(200),
        role: roleInput,
        // Supabase only honours origins on its own Redirect URLs allowlist, so
        // this cannot be pointed at an attacker's domain.
        redirectTo: z.string().url().max(500),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const email = data.email.trim().toLowerCase();

    // Raises if the caller isn't an admin, or the email is already on the team.
    const { data: memberId, error } = await context.supabase.rpc("org_invite_member", {
      p_email: email,
      p_role: data.role,
    });
    if (error) throw new Error(error.message);

    try {
      await sendInviteEmail(email, data.redirectTo);
    } catch (err) {
      await context.supabase.rpc("org_discard_invite", { p_member_id: memberId as string });
      throw err;
    }

    return { ok: true, email, role: data.role };
  });

/** Re-send the invite email for a member who hasn't set a password yet. */
export const resendInvite = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) =>
    z.object({ memberId: z.string().uuid(), redirectTo: z.string().url().max(500) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { data: member, error } = await context.supabase
      .from("organization_members")
      .select("id, email, role, password_set")
      .eq("id", data.memberId)
      .eq("org_id", context.orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!member) throw new Error("Member not found");
    // password_set, not status — the invite creates their account right away, so
    // status is 'active' from the moment it is sent. Owing us a password is what
    // makes an invite still outstanding.
    if (member.password_set) {
      throw new Error("That member has already set their password.");
    }

    await sendInviteEmail(member.email, data.redirectTo);
    return { ok: true };
  });

/**
 * Change a member's role. The database refuses to demote the last remaining
 * admin — an org with no admin could never add a product again.
 */
export const updateMemberRole = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) =>
    z.object({ memberId: z.string().uuid(), role: roleInput }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.rpc("org_update_member_role", {
      p_member_id: data.memberId,
      p_role: data.role,
    });
    if (error) throw new Error(error.message);
    // The middleware caches roles for a few seconds; without this the demoted
    // admin would keep passing requireOrgAdmin until the TTL lapsed.
    invalidateAllMemberships();
    return { ok: true };
  });

/**
 * Remove someone from the org AND delete their account.
 *
 * A user belongs to exactly one organization, so a membership-less account is
 * good for nothing except squatting on an email address — which would block
 * ever re-inviting that person, since Supabase won't invite an address that
 * already has an account. So the account goes too.
 *
 * What does NOT go: the org's history. products/stock_items/sales.user_id are
 * ON DELETE SET NULL (see the 20260716 migration), so every sale the person rang
 * up and every product they added stays exactly where it is — it belongs to the
 * organization, not to them. Only the attribution goes null.
 *
 * The database enforces the guards (admin only, not yourself, never the last
 * admin) and hands back the auth user id; deleting the account itself needs the
 * admin Auth API, which is the one thing the service-role key is for.
 */
export const removeMember = createServerFn({ method: "POST" })
  .middleware([requireOrgAdmin])
  .inputValidator((d: unknown) => z.object({ memberId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: removedUserId, error } = await context.supabase.rpc("org_remove_member", {
      p_member_id: data.memberId,
    });
    if (error) throw new Error(error.message);

    // Their cached membership must go with them, or they keep passing the
    // middleware until the TTL lapses.
    invalidateAllMemberships();

    // NULL means the row was a never-claimed invite — there is no account to
    // delete, and removing the membership row was the whole job.
    if (!removedUserId) return { ok: true, accountDeleted: false };

    const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(
      removedUserId as string,
    );
    if (deleteErr) {
      // The membership is already gone, so they have lost access either way —
      // that is the part that matters and it is done. Only the account cleanup
      // failed, so say so plainly rather than implying nothing happened.
      throw new Error(
        `Removed from the team, but their login account could not be deleted: ${deleteErr.message}. ` +
          `Delete it manually under Authentication > Users if you need to re-invite this email.`,
      );
    }

    return { ok: true, accountDeleted: true };
  });
