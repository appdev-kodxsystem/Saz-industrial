"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type ProductRow } from "@/lib/inventory.functions";
import { toast } from "sonner";
import FileDrop from "@/components/ui/file-drop";

export function AddProductDrawer({
  open,
  onOpenChange,
  onSave,
  initialCategories = [],
  initialProduct = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (payload: Omit<ProductRow, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'pinned'> & { id?: string }) => Promise<void>;
  initialCategories?: string[];
  initialProduct?: ProductRow | null;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [model, setModel] = useState("");
  const [description, setDescription] = useState<string | null>(null);
  const [reorderAt, setReorderAt] = useState(5);
  // purchase price removed from product add/edit form per requirements
  const [isSaving, setIsSaving] = useState(false);
  

  useEffect(() => {
    if (!open) {
      setName("");
      setSku("");
      setImageUrl(null);
      setModel("");
      setDescription(null);
      setReorderAt(5);
    }
  }, [open]);

  useEffect(() => {
    if (open && typeof initialProduct !== 'undefined' && initialProduct) {
      setName(initialProduct.name ?? "");
      setSku(initialProduct.sku ?? "");
      setImageUrl(initialProduct.image_url ?? null);
      setImageFile(null);
      setModel(initialProduct.category ?? "");
      setDescription(initialProduct.description ?? null);
      setReorderAt(initialProduct.reorder_at ?? 5);
      
      
    }
  }, [open, initialProduct]);

  const models = [...initialCategories];

  function handleFile(file: File | null) {
    if (!file) {
      setImageFile(null);
      setImageUrl(null);
      return;
    }
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      setImageUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const usedModel = model.trim() || initialProduct?.category || "Uncategorized";
    if (!name || !sku) return toast.error("Please provide name and SKU");
    try {
      setIsSaving(true);
      // If an image file is selected, convert to data URL before saving
      let image_payload = imageUrl;
      if (imageFile && !imageUrl?.startsWith('http') && !imageUrl?.startsWith('https')) {
        // imageUrl should already be a data URL from the file reader
        image_payload = imageUrl;
      }

      const payload: any = {
        name,
        sku,
        image_url: image_payload,
        category: usedModel,
        description,
        reorder_at: reorderAt,
      };
      if (initialProduct?.id) payload.id = initialProduct.id;

      await onSave(payload);
      toast.success(initialProduct ? "Product updated" : "Product added");
      // reset local form state
      setName("");
      setSku("");
      setImageUrl(null);
      setImageFile(null);
      setModel("");
      setDescription(null);
      setReorderAt(5);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to add product");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
        <SheetHeader className="border-b border-hairline p-6">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-base font-semibold">{initialProduct ? 'Edit Product' : 'Add Product'}</SheetTitle>
          </div>
        </SheetHeader>

        <form onSubmit={submit} className="flex flex-col gap-4 p-6">
          <div>
            <label className="text-sm font-medium mb-2 block">Image</label>
            <FileDrop file={imageFile} previewUrl={imageUrl} onChange={(f) => handleFile(f)} accept={"image/*"} />
          </div>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Name</span>
            <input placeholder="e.g., Sewing machine" value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg p-2 ring-1 ring-hairline" />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">SKU</span>
            <input placeholder="e.g., TS-RED-001" value={sku} onChange={(e) => setSku(e.target.value)} className="rounded-lg p-2 ring-1 ring-hairline" />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Model</span>
            <input placeholder="e.g., MX-202" value={model} onChange={(e) => setModel(e.target.value)} className="rounded-lg p-2 ring-1 ring-hairline" />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Description</span>
            <textarea placeholder="Short description (optional)" value={description ?? ""} onChange={(e) => setDescription(e.target.value)} className="rounded-lg p-2 ring-1 ring-hairline" />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Reorder at</span>
            <input
              type="number"
              min={0}
              placeholder="0"
              value={reorderAt === 0 ? "" : reorderAt}
              onChange={(e) => {
                const v = e.target.value === "" ? 0 : Number(e.target.value);
                setReorderAt(Math.max(0, Number.isNaN(v) ? 0 : v));
              }}
              className="rounded-lg p-2 ring-1 ring-hairline"
            />
          </label>

          {/* Purchase price removed from product add/edit per requirements */}
        </form>

        <div className="sticky bottom-0 border-t border-hairline bg-surface/95 p-4 backdrop-blur">
          <div className="flex gap-2">
            <button onClick={() => onOpenChange(false)} className="flex-1 rounded-xl bg-secondary py-3 text-sm">Cancel</button>
            <button onClick={() => submit()} disabled={isSaving} className="flex-1 rounded-xl bg-primary py-3 text-sm text-primary-foreground disabled:opacity-50">
              {isSaving ? "Saving..." : "Save product"}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default AddProductDrawer;
