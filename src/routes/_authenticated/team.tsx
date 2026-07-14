import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Mail, MoreHorizontal, ShieldCheck, Trash2, UserPlus, Send } from "lucide-react";
import { toast } from "sonner";
import {
  listOrgMembers,
  inviteMember,
  removeMember,
  resendInvite,
  updateMemberRole,
  type OrgMember,
} from "@/lib/org.functions";
import type { OrgRole } from "@/integrations/supabase/org-middleware";
import { PageHeader } from "@/components/inventory/AppNav";
import { useOrg } from "@/hooks/use-org";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/team")({
  head: () => ({
    meta: [
      { title: "Team — SAZ Industrial" },
      { name: "description", content: "Invite teammates and manage their roles." },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: TeamPage,
});

const ROLE_COPY: Record<OrgRole, string> = {
  admin: "Full access — products, stock, purchases, reports and the team.",
  employee: "Can view inventory and make sales. Cannot add products or stock.",
};

// The invite link lands here; the page swaps to "set your password" when the
// URL carries an invite token. Built from the live origin so it works in dev,
// preview and production without a hardcoded host.
const inviteRedirectTo = () =>
  typeof window === "undefined" ? "" : `${window.location.origin}/reset-password`;

function TeamPage() {
  const qc = useQueryClient();
  const { org, membershipId } = useOrg();

  const list = useServerFn(listOrgMembers);
  const invite = useServerFn(inviteMember);
  const setRole = useServerFn(updateMemberRole);
  const remove = useServerFn(removeMember);
  const resend = useServerFn(resendInvite);

  const [email, setEmail] = useState("");
  const [role, setRole_] = useState<OrgRole>("employee");
  const [removing, setRemoving] = useState<OrgMember | null>(null);

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["org-members"],
    queryFn: () => list(),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["org-members"] });

  const inviteMut = useMutation({
    mutationFn: (vars: { email: string; role: OrgRole }) =>
      invite({ data: { ...vars, redirectTo: inviteRedirectTo() } }),
    onSuccess: (_res, vars) => {
      toast.success(`Invite sent to ${vars.email}`, {
        description: "They'll get an email with a link to set their password.",
      });
      setEmail("");
      setRole_("employee");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const roleMut = useMutation({
    mutationFn: (vars: { memberId: string; role: OrgRole }) => setRole({ data: vars }),
    onSuccess: () => {
      toast.success("Role updated");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMut = useMutation({
    mutationFn: (vars: { memberId: string }) => remove({ data: vars }),
    onSuccess: () => {
      toast.success("Member removed");
      setRemoving(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resendMut = useMutation({
    mutationFn: (vars: { memberId: string }) =>
      resend({ data: { ...vars, redirectTo: inviteRedirectTo() } }),
    onSuccess: () => toast.success("Invite re-sent"),
    onError: (e: Error) => toast.error(e.message),
  });

  function onInvite(e: React.FormEvent) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!clean) return;
    inviteMut.mutate({ email: clean, role });
  }

  return (
    <>
      <PageHeader title="Team" subtitle={org.name} />

      <main className="mx-auto max-w-4xl animate-in fade-in slide-in-from-bottom-3 px-4 py-6 duration-500 ease-out sm:px-6 lg:py-10">
        <section className="rounded-3xl bg-surface p-5 ring-1 ring-hairline sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <UserPlus className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Invite a teammate</h2>
          </div>

          <form onSubmit={onInvite} className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="relative flex-1">
              <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                autoComplete="off"
                className="w-full rounded-lg bg-surface-muted py-2.5 pl-9 pr-3 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <Select value={role} onValueChange={(v) => setRole_(v as OrgRole)}>
              <SelectTrigger className="h-auto w-full rounded-lg border-0 bg-surface-muted px-3 py-2.5 text-sm shadow-none ring-1 ring-hairline focus:ring-2 focus:ring-ring sm:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="employee">Employee</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>

            <button
              type="submit"
              disabled={inviteMut.isPending}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {inviteMut.isPending && <Loader2 className="size-4 animate-spin" />}
              Send invite
            </button>
          </form>

          <p className="mt-3 text-xs text-muted-foreground">{ROLE_COPY[role]}</p>
        </section>

        <section className="mt-6">
          <h2 className="mb-3 px-1 text-sm font-semibold">
            Members{" "}
            <span className="font-normal text-muted-foreground">
              {isLoading ? "" : `(${members.length})`}
            </span>
          </h2>

          {isLoading ? (
            <div className="flex items-center gap-2 rounded-2xl bg-surface p-6 text-sm text-muted-foreground ring-1 ring-hairline">
              <Loader2 className="size-4 animate-spin" /> Loading team…
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {members.map((m) => {
                const isSelf = m.id === membershipId;
                return (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline sm:p-4"
                  >
                    <Avatar member={m} />

                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {m.display_name ?? m.email}
                        </span>
                        {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
                      </div>
                      <span className="truncate text-xs text-muted-foreground">{m.email}</span>
                    </div>

                    {m.status === "pending" && (
                      <span className="hidden shrink-0 rounded-full bg-warning/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-warning-foreground ring-1 ring-hairline sm:inline">
                        Invite pending
                      </span>
                    )}

                    <RoleBadge role={m.role} />

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Manage ${m.email}`}
                        className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground hover:bg-accent"
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        {m.status === "pending" && (
                          <>
                            <DropdownMenuItem
                              onClick={() => resendMut.mutate({ memberId: m.id })}
                            >
                              <Send className="size-4" /> Resend invite
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem
                          disabled={m.role === "admin"}
                          onClick={() => roleMut.mutate({ memberId: m.id, role: "admin" })}
                        >
                          <ShieldCheck className="size-4" /> Make admin
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={m.role === "employee"}
                          onClick={() => roleMut.mutate({ memberId: m.id, role: "employee" })}
                        >
                          <ShieldCheck className="size-4" /> Make employee
                        </DropdownMenuItem>
                        {!isSelf && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setRemoving(m)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="size-4" /> Remove from team
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && !removeMut.isPending && setRemoving(null)}
        title="Remove from team?"
        description={
          <>
            <span className="font-medium text-foreground">
              {removing?.display_name ?? removing?.email}
            </span>{" "}
            will immediately lose access to this organization's inventory, sales and payments.
            Their account is not deleted, and the sales they recorded stay in your history.
          </>
        }
        confirmText="Remove"
        icon={<Trash2 className="size-6" />}
        loading={removeMut.isPending}
        onConfirm={() => removing && removeMut.mutate({ memberId: removing.id })}
      />
    </>
  );
}

function RoleBadge({ role }: { role: OrgRole }) {
  const admin = role === "admin";
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide ring-1 ring-hairline ${
        admin ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"
      }`}
    >
      {admin ? "Admin" : "Employee"}
    </span>
  );
}

function Avatar({ member }: { member: OrgMember }) {
  const initial = (member.display_name ?? member.email).trim().charAt(0).toUpperCase();
  if (member.avatar_url) {
    return (
      <img
        src={member.avatar_url}
        alt=""
        className="size-10 shrink-0 rounded-full object-cover ring-1 ring-hairline"
      />
    );
  }
  return (
    <div className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-muted text-sm font-medium text-muted-foreground ring-1 ring-hairline">
      {initial}
    </div>
  );
}
