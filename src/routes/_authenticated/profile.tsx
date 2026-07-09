import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Upload, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { getMyProfile, updateMyProfile } from "@/lib/profile.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuthUser } from "@/hooks/use-auth-user";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Profile — SAZ Industrial" },
      { name: "description", content: "Manage your profile and account preferences." },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const qc = useQueryClient();
  const get = useServerFn(getMyProfile);
  const save = useServerFn(updateMyProfile);

  const { user } = useAuthUser();
  const { data, isLoading } = useQuery({ queryKey: ["profile"], queryFn: () => get() });

  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Fall back to the Google profile picture until a custom one is uploaded.
  const googleAvatar = user?.user_metadata?.avatar_url as string | undefined;
  const shownAvatar = avatarUrl || googleAvatar || "";

  useEffect(() => {
    if (data) {
      setDisplayName(data.display_name ?? "");
      setAvatarUrl(data.avatar_url ?? "");
    }
  }, [data]);

  const mut = useMutation({
    mutationFn: (v: { display_name: string | null; avatar_url: string | null }) =>
      save({ data: v }),
    onSuccess: () => {
      toast.success("Profile saved");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    mut.mutate({
      display_name: displayName.trim() || null,
      avatar_url: avatarUrl.trim() || null,
    });
  }

  async function persistAvatar(url: string | null) {
    await save({ data: { avatar_url: url } });
    setAvatarUrl(url ?? "");
    qc.invalidateQueries({ queryKey: ["profile"] });
    qc.invalidateQueries({ queryKey: ["profile-avatar"] });
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5 MB");
      return;
    }
    if (!data?.id) {
      toast.error("Profile not loaded yet");
      return;
    }
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${data.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      await persistAvatar(pub.publicUrl);
      toast.success("Profile photo updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function onRemoveAvatar() {
    setUploading(true);
    try {
      await persistAvatar(null);
      toast.success("Profile photo removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove photo");
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <main className="mx-auto max-w-2xl animate-in fade-in slide-in-from-bottom-3 px-4 py-10 duration-500 ease-out sm:px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage how you appear inside SAZ Industrial.
          </p>
        </div>

        {isLoading ? (
          <div className="rounded-2xl bg-surface p-6 ring-1 ring-hairline">
            <div className="h-4 w-32 animate-pulse rounded bg-surface-muted" />
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-6 rounded-3xl bg-surface p-6 ring-1 ring-hairline sm:p-8"
          >
            <div className="flex items-center gap-4">
              <div className="relative size-16 shrink-0 overflow-hidden rounded-full bg-secondary ring-1 ring-hairline">
                {shownAvatar ? (
                  <img src={shownAvatar} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-lg font-semibold text-muted-foreground">
                    {(displayName || "U").slice(0, 1).toUpperCase()}
                  </div>
                )}
                {uploading && (
                  <div className="absolute inset-0 grid place-items-center bg-background/60">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-semibold">
                  {displayName || "Unnamed user"}
                </h2>
                <p className="truncate text-xs text-muted-foreground">{user?.email || ""}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onPickFile}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
                  >
                    <Upload className="size-3.5" /> Upload photo
                  </button>
                  {avatarUrl && (
                    <button
                      type="button"
                      onClick={onRemoveAvatar}
                      disabled={uploading}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-destructive hover:bg-secondary disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" /> Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <Field label="Display name">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={120}
                placeholder="Your name"
                autoComplete="name"
                className="w-full rounded-lg bg-surface-muted px-3 py-2.5 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </Field>
            <div className="flex flex-col gap-3 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => setPwOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm font-medium hover:bg-secondary"
              >
                <KeyRound className="size-4" /> Change password
              </button>
              <button
                type="submit"
                disabled={mut.isPending}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {mut.isPending && <Loader2 className="size-4 animate-spin" />}
                Save changes
              </button>
            </div>
          </form>
        )}
      </main>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} email={user?.email ?? ""} />
    </>
  );
}

function ChangePasswordDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  email: string;
}) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPw.length < 6) {
      toast.error("New password must be at least 6 characters");
      return;
    }
    if (newPw !== confirmPw) {
      toast.error("New passwords do not match");
      return;
    }
    if (oldPw === newPw) {
      toast.error("New password must differ from the old one");
      return;
    }
    setBusy(true);
    try {
      // Verify the current password by re-authenticating with it.
      const { error: verifyErr } = await supabase.auth.signInWithPassword({
        email,
        password: oldPw,
      });
      if (verifyErr) {
        toast.error("Current password is incorrect");
        return;
      }
      const { error: updErr } = await supabase.auth.updateUser({ password: newPw });
      if (updErr) throw updErr;
      toast.success("Password changed");
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Enter your current password, then choose a new one.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="Current password">
            <input
              type="password"
              required
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
              className="w-full rounded-lg bg-surface-muted px-3 py-2.5 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>
          <Field label="New password">
            <input
              type="password"
              required
              minLength={6}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="At least 6 characters"
              autoComplete="new-password"
              className="w-full rounded-lg bg-surface-muted px-3 py-2.5 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>
          <Field label="Confirm new password">
            <input
              type="password"
              required
              minLength={6}
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="Re-enter new password"
              autoComplete="new-password"
              className="w-full rounded-lg bg-surface-muted px-3 py-2.5 text-sm ring-1 ring-hairline focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>
          <DialogFooter className="mt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center justify-center rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm font-medium hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Update password
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
