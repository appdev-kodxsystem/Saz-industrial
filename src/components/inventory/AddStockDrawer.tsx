"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type ProductRow, addStockEntries } from "@/lib/inventory.functions";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

export default function AddStockDrawer({ product, open, onOpenChange, onAdded }: {
  product: ProductRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded?: () => void;
}) {
  const [quantity, setQuantity] = useState<string>("");
  const [rows, setRows] = useState<{ manufacture_id: string; purchase_price: number }[]>([]);
  const [globalPrice, setGlobalPrice] = useState<number | "">("");
  const addStock = useServerFn(addStockEntries);
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuantity("");
      setRows([]);
      return;
    }
    if (product) {
      setRows([{ manufacture_id: "", purchase_price: Number(product.purchase_price ?? 0) }]);
      setGlobalPrice("");
      setQuantity("");
    }
  }, [open, product]);

  useEffect(() => {
    // adjust rows array length when quantity changes; allow empty (erasable)
    setRows((r) => {
      const n = Number(quantity);
      if (!quantity || Number.isNaN(n) || n < 1) return [];
      const next = Array.from({ length: Math.max(1, n) }, (_, i) => r[i] ?? { manufacture_id: "", purchase_price: Number(product?.purchase_price ?? 0) });
      return next;
    });
  }, [quantity, product]);

  if (!product) return null;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const qty = Number(quantity);
    if (!quantity || Number.isNaN(qty) || qty < 1) return toast.error("Quantity must be at least 1");
    // validate manufacture ids
    if (rows.length !== qty) return toast.error("Rows do not match quantity");
    if (rows.some((r) => !r.manufacture_id.trim())) return toast.error("Each unit needs a manufacture id");
    try {
      setIsAdding(true);
      await addStock({ data: { productId: product!.id, entries: rows } });
      toast.success("Stock added");
      onOpenChange(false);
      onAdded?.();
    } catch (err: any) {
      toast.error(err?.message || "Failed to add stock");
    } finally {
      setIsAdding(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
        <SheetHeader className="border-b border-hairline p-6">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-base font-semibold">Add Stock — {product.name}</SheetTitle>
          </div>
        </SheetHeader>

        <form onSubmit={submit} className="flex flex-col gap-4 p-6">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Quantity</span>
            <input type="number" min={1} placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="rounded-lg p-2 ring-1 ring-hairline" />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Global purchase price (applies to all rows)</span>
            <input type="number" min={0} placeholder="Purchase price" value={globalPrice === "" ? "" : String(globalPrice)} onChange={(e) => {
              const v = e.target.value === "" ? "" : Number(e.target.value);
              setGlobalPrice(v as any);
              if (v !== "") {
                setRows((prev) => prev.map((r) => ({ ...r, purchase_price: Number.isNaN(Number(v)) ? 0 : Number(v) })));
              }
            }} className="rounded-lg p-2 ring-1 ring-hairline" />
          </label>

          <div className="space-y-3">
            {rows.map((r, idx) => (
              <div key={idx} className="grid grid-cols-2 gap-3 items-center">
                <input placeholder={`Manufacture id #${idx + 1}`} value={r.manufacture_id} onChange={(e) => setRows((prev) => { const copy = [...prev]; copy[idx] = { ...copy[idx], manufacture_id: e.target.value }; return copy; })} className="rounded-lg p-2 ring-1 ring-hairline" />
                <input type="number" min={0} placeholder="Purchase price" value={r.purchase_price ?? ""} onChange={(e) => setRows((prev) => { const copy = [...prev]; const v = e.target.value === "" ? 0 : Number(e.target.value); copy[idx] = { ...copy[idx], purchase_price: Math.max(0, Number.isNaN(v) ? 0 : v) }; return copy; })} className="rounded-lg p-2 ring-1 ring-hairline" />
              </div>
            ))}
          </div>
        </form>

        <div className="sticky bottom-0 border-t border-hairline bg-surface/95 p-4 backdrop-blur">
          <div className="flex gap-2">
            <button onClick={() => onOpenChange(false)} className="flex-1 rounded-xl bg-secondary py-3 text-sm">Cancel</button>
            <button onClick={() => submit()} disabled={isAdding} className="flex-1 rounded-xl bg-primary py-3 text-sm text-primary-foreground disabled:opacity-50">
              {isAdding ? "Adding..." : "Add stock"}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
