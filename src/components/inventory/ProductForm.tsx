"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Package, Save } from "lucide-react";
import FileDrop from "@/components/ui/file-drop";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { upsertProduct, type ProductRow } from "@/lib/inventory.functions";

/** Derive a first-guess SKU from the product name: "Apex Mitre Saw" → "APE-MIT-SAW". */
function suggestSku(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (!words.length) return "";
  return words.map((w) => w.slice(0, 3)).join("-");
}

/**
 * Full-page create/edit form for a catalogue product. Replaces the old side
 * drawer: adding a product is a deliberate act with eight fields on it, and it
 * deserves the whole page rather than a 380px column.
 *
 * Purchase price is deliberately absent — cost is a property of a stock unit,
 * not of the catalogue entry, and it is captured when stock is received.
 * Selling price IS here: it is the list price, and it prefills every sale line.
 */
export function ProductForm({
  initial,
  categories,
}: {
  initial: ProductRow | null;
  categories: string[];
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const upsert = useServerFn(upsertProduct);
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [sku, setSku] = useState(initial?.sku ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [reorderAt, setReorderAt] = useState(String(initial?.reorder_at ?? 5));
  const [sellingPrice, setSellingPrice] = useState(
    initial?.selling_price ? String(initial.selling_price) : "",
  );
  const [imageUrl, setImageUrl] = useState<string | null>(initial?.image_url ?? null);
  const [imageFile, setImageFile] = useState<File | null>(null);

  // Once the SKU is typed in by hand it stops tracking the name. On an existing
  // product it never tracks — renaming a product must not silently renumber the
  // stock units already issued against its SKU.
  const skuTouched = useRef(isEdit);
  const suggestedSku = useMemo(() => suggestSku(name), [name]);
  useEffect(() => {
    if (!skuTouched.current) setSku(suggestedSku);
  }, [suggestedSku]);

  function handleFile(file: File | null) {
    if (!file) {
      setImageFile(null);
      setImageUrl(null);
      return;
    }
    if (!file.type.startsWith("image/")) return toast.error("Pick an image file");
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImageUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const trimmedSku = sku.trim();
  const valid = !!trimmedName && !!trimmedSku;

  async function submit(again = false) {
    if (!valid) return toast.error("Name and SKU are required");
    const payload: Record<string, unknown> = {
      name: trimmedName,
      sku: trimmedSku,
      image_url: imageUrl,
      category: category.trim() || "Uncategorized",
      description: description.trim() || null,
      reorder_at: Math.max(0, Number(reorderAt) || 0),
      selling_price: Math.max(0, Number(sellingPrice) || 0),
    };
    if (initial?.id) payload.id = initial.id;

    setSaving(true);
    try {
      await upsert({ data: payload });
      await qc.invalidateQueries({ queryKey: ["products"], refetchType: "active" });
      toast.success(isEdit ? "Product updated" : `${trimmedName} added`);
      if (!again) {
        navigate({ to: "/inventory" });
        return;
      }
      // "Save & add another" — clear the identity fields but keep category and
      // reorder level, which are almost always the same across a batch.
      setName("");
      setSku("");
      setDescription("");
      setSellingPrice("");
      setImageUrl(null);
      setImageFile(null);
      skuTouched.current = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save product");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={isEdit ? "Edit product" : "Add product"}
        subtitle={isEdit ? initial.name : "Create a catalogue entry — stock is received separately"}
        actions={
          <button
            onClick={() => navigate({ to: "/inventory" })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium transition hover:bg-accent"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
        }
      />

      <PageBody>
        {/*
          Three cards on one row from xl up (photo · details · pricing), photo +
          details on the first row at lg. `items-stretch` is the default, so with
          h-full on each card every card in a row ends at the same baseline
          instead of each one stopping wherever its own content happens to end.
        */}
        <div className="grid items-stretch gap-6 lg:grid-cols-3 xl:grid-cols-4">
          {/* image */}
          <section className="flex flex-col gap-3 lg:col-span-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Photo
            </h2>
            <div className="flex flex-1 flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-hairline">
              <div className="min-h-48 flex-1 bg-surface-muted">
                {imageUrl ? (
                  <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-muted-foreground/40">
                    <Package className="size-12" strokeWidth={1.25} />
                  </div>
                )}
              </div>
              <div className="p-3">
                <FileDrop
                  file={imageFile}
                  previewUrl={imageUrl}
                  onChange={handleFile}
                  accept="image/*"
                />
              </div>
            </div>
          </section>

          {/* details */}
          <section className="flex flex-col gap-3 lg:col-span-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Details
            </h2>
            <div className="flex flex-1 flex-col gap-4 rounded-2xl bg-surface p-5 ring-1 ring-hairline">
              <Field label="Name" required>
                <input
                  autoFocus={!isEdit}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Apex Mitre Saw Pro X1"
                  className={inputCls}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="SKU"
                  required
                  hint={
                    !isEdit && !skuTouched.current
                      ? "Suggested from the name — edit if you like"
                      : undefined
                  }
                >
                  <input
                    value={sku}
                    onChange={(e) => {
                      skuTouched.current = true;
                      setSku(e.target.value);
                    }}
                    placeholder="e.g. MS-402-B"
                    className={`${inputCls} font-mono uppercase`}
                  />
                </Field>

                <Field label="Model / Category">
                  <input
                    list="product-categories"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Power Tools"
                    className={inputCls}
                  />
                  <datalist id="product-categories">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </Field>
              </div>

              {/* Grows to absorb the row's spare height, so the card's bottom
                  edge lines up with the photo card's without a gap under the
                  last field. */}
              <Field label="Description" className="flex-1">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description (optional)"
                  className={`${inputCls} h-full min-h-24 resize-y py-2.5`}
                />
              </Field>
            </div>
          </section>

          {/* pricing */}
          <section className="flex flex-col gap-3 lg:col-span-3 xl:col-span-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pricing &amp; stock
            </h2>
            <div className="grid flex-1 content-start gap-4 rounded-2xl bg-surface p-5 ring-1 ring-hairline sm:grid-cols-2 xl:grid-cols-1">
              <Field
                label="Default selling price"
                hint="Prefills every sale line. Editable per sale."
              >
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    Rs
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={sellingPrice}
                    onChange={(e) => setSellingPrice(e.target.value)}
                    placeholder="0"
                    className={`${inputCls} pl-9 tabular-nums`}
                  />
                </div>
              </Field>

              <Field label="Low-stock alert at" hint="Flags the product once stock drops to this.">
                <input
                  type="number"
                  min={0}
                  value={reorderAt}
                  onChange={(e) => setReorderAt(e.target.value)}
                  placeholder="5"
                  className={`${inputCls} tabular-nums`}
                />
              </Field>
            </div>
          </section>
        </div>

        {/* Actions sit below the whole grid, not inside one column, so they stay
            put no matter how the cards reflow across breakpoints. */}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          {!isEdit && (
            <button
              onClick={() => submit(true)}
              disabled={!valid || saving}
              className="rounded-xl bg-secondary px-5 py-3 text-sm font-medium ring-1 ring-hairline transition hover:bg-accent disabled:opacity-50"
            >
              Save &amp; add another
            </button>
          )}
          <button
            onClick={() => submit(false)}
            disabled={!valid || saving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-primary/85 px-8 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none sm:min-w-52"
          >
            <Save className="size-4" />
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add product"}
          </button>
        </div>
      </PageBody>
    </>
  );
}

const inputCls =
  "h-11 w-full rounded-xl bg-surface-muted px-3 text-sm outline-none ring-1 ring-hairline transition focus:ring-2 focus:ring-primary/40";

function Field({
  label,
  hint,
  required,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-foreground">
        {label}
        {required && <span className="ml-0.5 text-danger-foreground">*</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
