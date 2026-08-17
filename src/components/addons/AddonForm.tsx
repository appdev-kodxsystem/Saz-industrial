"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Gift, Save } from "lucide-react";
import FileDrop from "@/components/ui/file-drop";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { upsertAddon, type AddonRow } from "@/lib/addons.functions";

/** Derive a first-guess code from the name: "Spare Blade" → "SPA-BLA". */
function suggestCode(name: string): string {
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
 * Create/edit form for an add-on — the free extras handed over with a machine.
 *
 * Deliberately mirrors ProductForm, because an add-on IS a catalogue entry: it
 * has a name, a code, a category and a photo, and its stock arrives separately
 * through a stock order rather than being typed in here. Two fields are its own:
 *
 *   Unit cost  — what one costs the organization. This is the number that comes
 *                off the profit of every sale the add-on rides out on, so it is
 *                the whole reason add-ons are tracked at all.
 *   List value — what it is worth to the CUSTOMER, for the receipt line
 *                ("free carry case, worth Rs 2,500"). Display only: it is never
 *                charged and never enters a profit calculation.
 */
export function AddonForm({
  initial,
  categories,
}: {
  initial: AddonRow | null;
  categories: string[];
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const upsert = useServerFn(upsertAddon);
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [unitCost, setUnitCost] = useState(initial?.unit_cost ? String(initial.unit_cost) : "");
  const [listValue, setListValue] = useState(initial?.list_value ? String(initial.list_value) : "");
  const [reorderAt, setReorderAt] = useState(String(initial?.reorder_at ?? 5));
  const [active, setActive] = useState(initial?.active ?? true);
  const [imageUrl, setImageUrl] = useState<string | null>(initial?.image_url ?? null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // Once the code is typed by hand it stops tracking the name. On an existing
  // add-on it never tracks — renaming must not silently renumber the batches
  // already issued against its code.
  const codeTouched = useRef(isEdit);
  const suggested = useMemo(() => suggestCode(name), [name]);
  useEffect(() => {
    if (!codeTouched.current) setCode(suggested);
  }, [suggested]);

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

  const trimmedName = name.trim();
  const trimmedCode = code.trim();
  const valid = !!trimmedName && !!trimmedCode;

  async function submit(again = false) {
    if (!valid) return toast.error("Name and code are required");

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmedName,
        code: trimmedCode,
        category: category.trim() || "Uncategorized",
        description: description.trim() || null,
        image_url: imageUrl,
        unit_cost: Math.max(0, Number(unitCost) || 0),
        list_value: Math.max(0, Number(listValue) || 0),
        reorder_at: Math.max(0, Number(reorderAt) || 0),
        active,
      };
      if (initial?.id) payload.id = initial.id;

      await upsert({ data: payload });
      await qc.invalidateQueries({ queryKey: ["addons"], refetchType: "active" });
      toast.success(isEdit ? "Add-on updated" : `${trimmedName} added`);

      if (!again) {
        navigate({ to: "/addons" });
        return;
      }
      // "Save & add another" — clear the identity fields but keep category and
      // reorder level, which are almost always the same across a batch.
      setName("");
      setCode("");
      setDescription("");
      setUnitCost("");
      setListValue("");
      setImageUrl(null);
      setImageFile(null);
      codeTouched.current = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save add-on");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={isEdit ? "Edit add-on" : "Add add-on"}
        subtitle={isEdit ? initial.name : "Create a catalogue entry — stock is received separately"}
        actions={
          <button
            onClick={() => navigate({ to: "/addons" })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium transition hover:bg-accent"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
        }
      />

      <PageBody>
        <div className="grid items-stretch gap-6 lg:grid-cols-3 xl:grid-cols-4">
          {/* photo */}
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
                    <Gift className="size-12" strokeWidth={1.25} />
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
                  placeholder="e.g. Spare Carbide Blade"
                  className={inputCls}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Code"
                  required
                  hint={
                    !isEdit && !codeTouched.current
                      ? "Suggested from the name — edit if you like"
                      : "Batch codes are issued from this: TK-01-B0001, …"
                  }
                >
                  <input
                    value={code}
                    onChange={(e) => {
                      codeTouched.current = true;
                      setCode(e.target.value);
                    }}
                    placeholder="e.g. TK-01"
                    className={`${inputCls} font-mono uppercase`}
                  />
                </Field>

                <Field label="Category" hint="Add-ons keep their own categories.">
                  <input
                    list="addon-categories"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Consumables"
                    className={inputCls}
                  />
                  <datalist id="addon-categories">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </Field>
              </div>

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
              Cost &amp; stock
            </h2>
            <div className="grid flex-1 content-start gap-4 rounded-2xl bg-surface p-5 ring-1 ring-hairline sm:grid-cols-2 xl:grid-cols-1">
              <Field
                label="Default unit cost"
                hint="Prefills the stock-in form. What actually hits profit is the cost of the batch it came from."
              >
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    Rs
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
                    placeholder="0"
                    className={`${inputCls} pl-9 tabular-nums`}
                  />
                </div>
              </Field>

              <Field
                label="Value to customer"
                hint="Shown on the receipt as what the giveaway is worth. Never charged."
              >
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    Rs
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={listValue}
                    onChange={(e) => setListValue(e.target.value)}
                    placeholder="0"
                    className={`${inputCls} pl-9 tabular-nums`}
                  />
                </div>
              </Field>

              <Field label="Low-stock alert at" hint="Flags the add-on once stock drops to this.">
                <input
                  type="number"
                  min={0}
                  value={reorderAt}
                  onChange={(e) => setReorderAt(e.target.value)}
                  placeholder="5"
                  className={`${inputCls} tabular-nums`}
                />
              </Field>

              {/* Retiring keeps the add-on on every sale it already went out on
                  — it only disappears from the sell-time picker. */}
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-surface-muted p-3 ring-1 ring-hairline">
                <span className="flex flex-col">
                  <span className="text-xs font-medium">Available to give away</span>
                  <span className="text-[11px] text-muted-foreground">
                    Turn off to retire it without losing its history.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="size-4 shrink-0 accent-primary"
                />
              </label>
            </div>
          </section>
        </div>

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
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add add-on"}
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
