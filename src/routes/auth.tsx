import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import FileDrop from "@/components/ui/file-drop";
import { Loader2, Mail, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — SAZ Industrial" },
      { name: "description", content: "Sign in or create an account to manage your inventory." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgotError, setForgotError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/inventory", replace: true });
    });
  }, [navigate]);

  // Quick debug route: append ?debug=1 to test FileDrop without auth
  if (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1"
  ) {
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    function handleFile(f: File | null) {
      setFile(f);
      if (!f) return setPreview(null);
      const r = new FileReader();
      r.onload = () => setPreview(r.result as string);
      r.readAsDataURL(f);
    }
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <h1 className="mb-4 text-lg font-semibold">Debug FileDrop (auth)</h1>
        <FileDrop
          file={file}
          previewUrl={preview}
          onChange={handleFile}
          accept={"image/*,application/pdf"}
        />
        <div className="mt-4">Selected: {file ? file.name : "(none)"}</div>
      </div>
    );
  }

  async function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/inventory`,
            data: { full_name: name || undefined },
          },
        });
        if (error) throw error;
        toast.success("Account created. Check your email if confirmation is required.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await router.invalidate();
      navigate({ to: "/inventory", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function onForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setForgotError("");
    setBusy(true);
    try {
      const { data: exists, error: checkErr } = await supabase.rpc("email_exists", {
        p_email: email,
      });
      if (checkErr) throw checkErr;
      if (!exists) {
        setForgotError("No account found with that email.");
        return;
      }
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      toast.success("Reset link sent. Check your email.");
      setMode("signin");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send reset email");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/inventory`,
        },
      });
      if (error) throw error;
      // Supabase redirects the browser to Google; nothing more to do here.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Toaster position="top-right" />
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-6 sm:py-12">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground sm:mb-8"
        >
          ← Back
        </Link>
        <div className="rounded-3xl bg-surface p-6 ring-1 ring-hairline shadow-xl shadow-foreground/5 sm:p-8">
          <div className="mb-4 flex items-center gap-3 sm:mb-6">
            <img
              src="/logo.webp"
              alt="SAZ Industrial"
              width={40}
              height={40}
              className="h-9 w-auto rounded-md object-contain"
            />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {mode === "signin"
                  ? "Welcome back"
                  : mode === "signup"
                    ? "Create your account"
                    : "Reset your password"}
              </h1>
              <p className="text-xs text-muted-foreground">SAZ Industrial</p>
            </div>
          </div>

          {mode === "forgot" ? (
            <form onSubmit={onForgotSubmit} className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Enter your account email and we'll send you a link to reset your password.
              </p>
              <Field label="Email">
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (forgotError) setForgotError("");
                    }}
                    placeholder="you@company.com"
                    autoComplete="email"
                    className="w-full rounded-lg bg-surface-muted py-2.5 pl-9 pr-3 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </Field>
              {forgotError && <p className="text-xs text-destructive">{forgotError}</p>}
              <button
                type="submit"
                disabled={busy}
                className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Send reset link
              </button>
              <button
                type="button"
                onClick={() => setMode("signin")}
                className="mt-1 text-center text-xs font-medium text-foreground underline-offset-4 hover:underline"
              >
                Back to sign in
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={onGoogle}
                disabled={busy}
                className="mb-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm font-medium hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50 sm:mb-6"
              >
                <GoogleIcon />
                Continue with Google
              </button>

              <div className="relative mb-4 flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground sm:mb-6">
                <div className="h-px flex-1 bg-hairline" />
                or
                <div className="h-px flex-1 bg-hairline" />
              </div>

              <form onSubmit={onEmailSubmit} className="flex flex-col gap-3">
                {mode === "signup" && (
                  <Field label="Name">
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Abdullah Khan"
                      autoComplete="name"
                      className="w-full rounded-lg bg-surface-muted px-3 py-2.5 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </Field>
                )}
                <Field label="Email">
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      autoComplete="email"
                      className="w-full rounded-lg bg-surface-muted py-2.5 pl-9 pr-3 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </Field>
                <Field label="Password">
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={
                        mode === "signup" ? "At least 6 characters" : "Enter your password"
                      }
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                      className="w-full rounded-lg bg-surface-muted py-2.5 pl-9 pr-3 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </Field>
                {mode === "signin" && (
                  <button
                    type="button"
                    onClick={() => setMode("forgot")}
                    className="-mt-1 self-end text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {mode === "signin" ? "Sign in" : "Create account"}
                </button>
              </form>

              <p className="mt-4 text-center text-xs text-muted-foreground sm:mt-6">
                {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
                <button
                  type="button"
                  onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {mode === "signin" ? "Sign up" : "Sign in"}
                </button>
              </p>
            </>
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

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.65l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}
