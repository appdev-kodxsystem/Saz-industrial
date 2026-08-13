import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { getMyOrg, markPasswordSet, MY_ORG_QUERY_KEY } from "@/lib/org.functions";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Reset password — SAZ Industrial" },
      { name: "description", content: "Choose a new password for your account." },
    ],
  }),
  component: ResetPasswordPage,
});

// A password-reset link says so in the URL hash. An INVITE, though, can arrive
// here two ways: straight off the email link (hash says type=invite), or bounced
// here by the /_authenticated guard because the member's password_set is still
// false. The hash alone therefore under-detects invites — see below, where the
// database gets the final say.
function hashSaysInvite() {
  if (typeof window === "undefined") return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return hash.get("type") === "invite";
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const fetchOrg = useServerFn(getMyOrg);
  const confirmPasswordSet = useServerFn(markPasswordSet);

  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(hashSaysInvite);

  // The email lands here with a token in the URL hash. The supabase client
  // (detectSessionInUrl) exchanges it for a session and fires PASSWORD_RECOVERY.
  // Either path means we can let the user set a password.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setReady(true);
    });

    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) {
        setChecking(false);
        return;
      }
      setReady(true);

      // Ask the database whether this person still owes us a password. That is
      // the authoritative answer: it's true for an invitee no matter which URL
      // Supabase happened to drop them on, and false for someone merely
      // resetting. A failure here just means "not an invite" — never block the
      // reset flow on it.
      try {
        const membership = await fetchOrg();
        if (!membership.passwordSet) setInvite(true);
      } catch {
        // no membership / backend hiccup — fall back to the URL's verdict
      } finally {
        setChecking(false);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [fetchOrg]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      if (invite) {
        // Clear password_set so the /_authenticated guard stops bouncing them
        // back here. Do this BEFORE navigating, or the guard fires again and
        // they ping-pong on this screen forever. invalidate() then forces
        // beforeLoad to re-read the membership rather than reuse the cached
        // context that still says "no password".
        await confirmPasswordSet({ data: undefined });
        // beforeLoad reads the membership through the query cache now, and
        // router.invalidate() re-runs beforeLoad without touching that cache —
        // so drop the stale "no password" entry first, or the guard reuses it
        // and bounces them straight back here.
        queryClient.removeQueries({ queryKey: MY_ORG_QUERY_KEY });
        await router.invalidate();
        toast.success("Welcome aboard! Your password is set.");
        navigate({ to: "/inventory", replace: true });
        return;
      }

      // Recovery: force a fresh login with the new password instead of dropping
      // straight into the app on the temporary recovery session.
      await supabase.auth.signOut();
      toast.success("Password updated. Please sign in with your new password.");
      navigate({ to: "/auth", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Toaster position="top-right" />
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-6 sm:py-12">
        {!invite && (
          <Link
            to="/auth"
            className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground sm:mb-8"
          >
            ← Back to sign in
          </Link>
        )}
        <div className="rounded-3xl bg-surface p-6 ring-1 ring-hairline shadow-xl shadow-foreground/5 sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">
            {invite ? "Set your password" : "Set a new password"}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {invite
              ? "You've been invited to SAZ Industrial. Choose a password to activate your account."
              : "Choose a new password for your account."}
          </p>

          {checking ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />{" "}
              {invite ? "Verifying invite link…" : "Verifying reset link…"}
            </div>
          ) : !ready ? (
            <div className="mt-6 space-y-3">
              <p className="text-sm text-muted-foreground">
                {invite
                  ? "This invite link is invalid or has expired. Ask an admin in your organization to send you a new one."
                  : "This reset link is invalid or has expired. Request a new one from the sign-in page."}
              </p>
              <Link
                to="/auth"
                className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
              <Field label={invite ? "Password" : "New password"}>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    autoComplete="new-password"
                    className="w-full rounded-lg bg-surface-muted py-2.5 pl-9 pr-3 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </Field>
              <Field label="Confirm password">
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Re-enter new password"
                    autoComplete="new-password"
                    className="w-full rounded-lg bg-surface-muted py-2.5 pl-9 pr-3 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </Field>
              <button
                type="submit"
                disabled={busy}
                className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {invite ? "Set password and continue" : "Update password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
