"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

/**
 * Opens the receipt photo attached to a stock order.
 *
 * The `receipts` bucket is private, so there is no URL to render straight into
 * an <a href>. The link is signed on click and expires in a minute, which also
 * means we never mint URLs for the rows nobody looks at.
 */
export function ReceiptLink({ path }: { path: string | null | undefined }) {
  const [busy, setBusy] = useState(false);

  if (!path) return <span className="text-muted-foreground">—</span>;

  async function open(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      const { data, error } = await supabase.storage
        .from("receipts")
        .createSignedUrl(path as string, 60);
      if (error || !data?.signedUrl)
        throw new Error(error?.message ?? "Could not open the receipt");
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open the receipt");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={open}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
    >
      <Receipt className="size-3.5" />
      {busy ? "Opening…" : "View"}
    </button>
  );
}
