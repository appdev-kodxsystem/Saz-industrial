import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
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

// An invite link and a password-reset link both land here, but they are
// different moments: one is a new teammate choosing their first password, the
// other is an existing user recovering. Supabase marks which is which with
// `type=invite` in the URL hash, so read it before the client consumes and
// clears the hash.
function isInviteLink() {
  if (typeof window === "undefined") return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return hash.get("type") === "invite";
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite] = useState(isInviteLink);

  // The email lands here with a token in the URL hash. The supabase client
  // (detectSessionInUrl) exchanges it for a session and fires PASSWORD_RECOVERY.
  // Either path means we can let the user set a password.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
      setChecking(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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
        // A new teammate just set their first password. Their membership was
        // already activated when the invite created their account, so drop them
        // straight into the app rather than bouncing them to a login form.
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
