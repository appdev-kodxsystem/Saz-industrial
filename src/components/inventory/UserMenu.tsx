import { Menu, LogOut, User as UserIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuthUser } from "@/hooks/use-auth-user";
import { useOrg } from "@/hooks/use-org";
import { getMyProfile } from "@/lib/profile.functions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function UserMenu() {
  const { user } = useAuthUser();
  const { org, role } = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const getProfile = useServerFn(getMyProfile);
  const { data: profile } = useQuery({
    queryKey: ["profile-avatar"],
    queryFn: () => getProfile(),
    enabled: !!user,
  });

  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const initials = (user?.user_metadata?.full_name || user?.email || "U")
    .split(/\s|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s: string) => s[0]?.toUpperCase())
    .join("");

  const handleSignOut = async () => {
    setSigningOut(true);
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  if (!user) return null;
  // Prefer the saved profile avatar (uploaded or Google, synced at signup);
  // fall back to the Google metadata avatar while the profile loads.
  const avatar = (profile?.avatar_url || user.user_metadata?.avatar_url) as string | undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="grid size-9 place-items-center overflow-hidden rounded-full bg-secondary ring-1 ring-hairline text-xs font-semibold hover:bg-accent"
      >
        {avatar ? (
          <img src={avatar} alt="" className="h-full w-full object-cover" />
        ) : (
          <span>{initials}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-secondary ring-1 ring-hairline text-xs font-semibold">
            {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initials}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm">{user.user_metadata?.full_name || "Account"}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
            <span className="mt-1 flex items-center gap-1.5">
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  role === "admin" ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"
                }`}
              >
                {role === "admin" ? "Admin" : "Employee"}
              </span>
              <span className="truncate text-[11px] font-normal text-muted-foreground">{org.name}</span>
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserIcon className="size-4" /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setConfirmOut(true);
          }}
          className="text-destructive focus:text-destructive"
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>

      <ConfirmDialog
        open={confirmOut}
        onOpenChange={(v) => !signingOut && setConfirmOut(v)}
        title="Sign out?"
        description="You'll need to sign in again to access your inventory."
        confirmText="Sign out"
        icon={<LogOut className="size-6" />}
        loading={signingOut}
        onConfirm={handleSignOut}
      />
    </DropdownMenu>
  );
}

export function MobileMenuButton() {
  return (
    <button
      aria-label="Menu"
      className="sm:hidden grid size-9 place-items-center rounded-lg bg-secondary text-secondary-foreground"
    >
      <Menu className="size-4" />
    </button>
  );
}
