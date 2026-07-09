import * as React from "react";
import { Loader2, AlertTriangle, LogOut } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";

type Tone = "destructive" | "default";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  tone = "destructive",
  icon,
  loading = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: Tone;
  icon?: React.ReactNode;
  loading?: boolean;
  onConfirm: () => void;
}) {
  const accent =
    tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary";
  const confirmBtn =
    tone === "destructive"
      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
      : "bg-primary text-primary-foreground hover:opacity-90";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm overflow-hidden rounded-2xl border-hairline bg-surface p-0">
        <div className="p-6">
          <AlertDialogHeader className="items-center text-center sm:text-center">
            <div className={`mb-2 grid size-12 place-items-center rounded-full ${accent}`}>
              {icon ?? <AlertTriangle className="size-6" />}
            </div>
            <AlertDialogTitle className="text-lg">{title}</AlertDialogTitle>
            {description && (
              <AlertDialogDescription className="text-sm text-muted-foreground">
                {description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter className="gap-2 border-t border-hairline bg-surface-muted/40 p-4 sm:justify-stretch">
          <button
            type="button"
            disabled={loading}
            onClick={() => onOpenChange(false)}
            className="flex-1 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50 ${confirmBtn}`}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {confirmText}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { LogOut as LogOutIcon };
