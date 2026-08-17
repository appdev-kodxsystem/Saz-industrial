import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Gift, PackagePlus, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  listAddons,
  deleteAddon as deleteAddonFn,
  setAddonActive as setAddonActiveFn,
  type AddonRow,
} from "@/lib/addons.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { AddonStockDrawer } from "@/components/addons/AddonStockDrawer";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { supabaseThumb } from "@/lib/img";
import { useOrg } from "@/hooks/use-org";

export const Route = createFileRoute("/_authenticated/addons/")({
  head: () => ({
    meta: [
      { title: "Add-ons — SAZ Industrial" },
      {
        name: "description",
        content: "Free extras handed out with a sale, paid for out of margin.",
      },
    ],
  }),
  // Deliberately NOT admin-only. An employee needs to see what is on the shelf
  // to know what they can promise at the counter — they just never see cost,
  // which the server strips from their payload.
  component: AddonsPage,
});

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

type StockFilter = "all" | "in_stock" | "low_stock" | "out_of_stock";

/** Same three-state stock reading products use, applied to derived on-hand.
 *  Kept unexported: a route module that exports non-components breaks fast
 *  refresh, and nothing outside this page needs it. */
function addonStockStatus(a: AddonRow): Exclude<StockFilter, "all"> {
  if (a.on_hand <= 0) return "out_of_stock";
  if (a.on_hand <= a.reorder_at) return "low_stock";
  return "in_stock";
}

function AddonsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isAdmin: canManage } = useOrg();

  const list = useServerFn(listAddons);
  const remove = useServerFn(deleteAddonFn);
  const setActive = useServerFn(setAddonActiveFn);

  const {
    data: addons = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["addons"],
    queryFn: () => list(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["addons"], refetchType: "active" });

  const delMut = useMutation({
    mutationFn: (v: { id: string }) => remove({ data: v }),
    onSuccess: () => {
      invalidate();
      setDeleteId(null);
      toast.success("Add-on deleted");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const activeMut = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => setActive({ data: v }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState<StockFilter>("all");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [stockFor, setStockFor] = useState<AddonRow | null>(null);

  const categories = useMemo(
    () => Array.from(new Set(addons.map((a) => a.category).filter(Boolean))).sort(),
    [addons],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return addons
      .filter((a) => (category === "all" ? true : a.category === category))
      .filter((a) => (status === "all" ? true : addonStockStatus(a) === status))
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          a.code.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q),
      );
  }, [addons, query, category, status]);

  const kpis = useMemo(() => {
    const live = addons.filter((a) => a.active);
    return {
      total: addons.length,
      onHand: addons.reduce((n, a) => n + a.on_hand, 0),
      value: addons.reduce((n, a) => n + a.on_hand_value, 0),
      low: live.filter((a) => addonStockStatus(a) !== "in_stock").length,
    };
  }, [addons]);

  return (
    <>
      <PageHeader
        title="Add-ons"
        subtitle="Free extras handed over with a sale — the cost comes off profit, never off the customer"
        actions={
          canManage ? (
            <>
              <button
                onClick={() => navigate({ to: "/stock/new" })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-hairline transition hover:bg-accent active:scale-95"
              >
                <PackagePlus className="size-4" />
                <span className="hidden sm:inline">Add Stock</span>
              </button>
              <button
                onClick={() => navigate({ to: "/addons/new" })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition active:scale-95"
              >
                <Plus className="size-4" />
                <span className="hidden sm:inline">Add Add-on</span>
              </button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search add-ons, code, category…"
              className="w-full rounded-lg bg-surface py-2.5 pl-9 pr-9 text-sm ring-1 ring-hairline placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-secondary"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 overflow-x-auto">
            {(
              [
                { id: "all", label: "All" },
                { id: "in_stock", label: "In stock" },
                { id: "low_stock", label: "Low" },
                { id: "out_of_stock", label: "Out" },
              ] as { id: StockFilter; label: string }[]
            ).map((s) => (
              <Chip key={s.id} active={status === s.id} onClick={() => setStatus(s.id)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </div>

        {categories.length > 0 && (
          <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
            <Chip active={category === "all"} onClick={() => setCategory("all")}>
              All categories
            </Chip>
            {categories.map((c) => (
              <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
      </PageHeader>

      <PageBody>
        <section className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Kpi label="Add-ons" value={String(kpis.total)} />
          <Kpi label="Units On Hand" value={String(kpis.onHand)} />
          <Kpi label="Needs Restock" value={String(kpis.low)} tone="warning" />
          {canManage && <Kpi label="Value On Hand" value={fmt.format(kpis.value)} />}
        </section>

        {error ? (
          <div className="rounded-2xl bg-surface p-10 text-center ring-1 ring-hairline">
            <p className="text-sm font-medium text-danger-foreground">
              {error instanceof Error ? error.message : "Failed to load add-ons"}
            </p>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-surface" />
            ))}
          </div>
        ) : addons.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface p-12 text-center ring-1 ring-hairline">
            <div className="grid size-16 place-items-center rounded-2xl bg-surface-muted">
              <Gift className="size-7 text-muted-foreground/40" strokeWidth={1.25} />
            </div>
            <div>
              <p className="text-sm font-medium">No add-ons yet</p>
              <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                An add-on is something you give away with a machine — a spare blade, a carry case, a
                warranty card. The customer pays nothing extra; the cost comes off your margin.
              </p>
            </div>
            {canManage && (
              <button
                onClick={() => navigate({ to: "/addons/new" })}
                className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
              >
                <Plus className="size-4" /> Add your first add-on
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">
            No add-ons match those filters.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((a) => (
              <AddonRowCard
                key={a.id}
                addon={a}
                canManage={canManage}
                onEdit={() => navigate({ to: "/addons/$addonId/edit", params: { addonId: a.id } })}
                onStock={() => setStockFor(a)}
                onDelete={() => setDeleteId(a.id)}
                onToggleActive={() => activeMut.mutate({ id: a.id, active: !a.active })}
              />
            ))}
          </div>
        )}
      </PageBody>

      <AddonStockDrawer
        addon={stockFor}
        open={!!stockFor}
        onOpenChange={(v) => !v && setStockFor(null)}
        canManage={canManage}
      />

      {canManage && (
        <ConfirmDialog
          open={!!deleteId}
          onOpenChange={(v) => !v && !delMut.isPending && setDeleteId(null)}
          title="Delete add-on?"
          description={
            <>
              {(() => {
                const name = addons.find((a) => a.id === deleteId)?.name;
                return (
                  <>
                    {name ? (
                      <span className="font-medium text-foreground">{name}</span>
                    ) : (
                      "This add-on"
                    )}{" "}
                    will be removed from the catalogue. Sales that already went out with it keep
                    their record, and so do the batches you bought — but its remaining stock stops
                    being countable. To take it out of circulation without that, turn off “Available
                    to give away” instead.
                  </>
                );
              })()}
            </>
          }
          confirmText="Delete"
          icon={<Trash2 className="size-6" />}
          loading={delMut.isPending}
          onConfirm={() => deleteId && delMut.mutate({ id: deleteId })}
        />
      )}
    </>
  );
}

function AddonRowCard({
  addon: a,
  canManage,
  onEdit,
  onStock,
  onDelete,
  onToggleActive,
}: {
  addon: AddonRow;
  canManage: boolean;
  onEdit: () => void;
  onStock: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
}) {
  const status = addonStockStatus(a);
  const tone =
    status === "out_of_stock"
      ? "bg-danger text-danger-foreground"
      : status === "low_stock"
        ? "bg-warning text-warning-foreground"
        : "bg-success text-success-foreground";

  return (
    <div
      className={`group flex flex-col gap-3 rounded-2xl bg-surface p-4 ring-1 ring-hairline transition hover:shadow-md sm:flex-row sm:items-center ${
        a.active ? "" : "opacity-60"
      }`}
    >
      <button
        onClick={onStock}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={`Stock history for ${a.name}`}
      >
        <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-surface-muted ring-1 ring-hairline">
          {a.image_url ? (
            <img
              src={supabaseThumb(a.image_url, 96)}
              alt={a.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted-foreground/40">
              <Gift className="size-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{a.name}</span>
            {!a.active && (
              <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Retired
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{a.code}</span> · {a.category}
          </div>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-4 sm:gap-6">
        <Stat label="On hand" value={String(a.on_hand)} badge={tone} />
        <Stat label="Given away" value={String(a.given_away)} />
        {canManage && <Stat label="Unit cost" value={fmt.format(a.unit_cost)} />}
        <Stat label="Worth" value={fmt.format(a.list_value)} muted />

        {canManage && (
          <div className="flex items-center gap-1">
            <IconButton label={`Add stock for ${a.name}`} onClick={onStock}>
              <PackagePlus className="size-4" />
            </IconButton>
            <IconButton label={`Edit ${a.name}`} onClick={onEdit}>
              <Pencil className="size-4" />
            </IconButton>
            <button
              onClick={onToggleActive}
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              {a.active ? "Retire" : "Restore"}
            </button>
            <IconButton label={`Delete ${a.name}`} onClick={onDelete} danger>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  badge,
  muted,
}: {
  label: string;
  value: string;
  badge?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {badge ? (
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${badge}`}>
          {value}
        </span>
      ) : (
        <span
          className={`text-sm font-semibold tabular-nums ${muted ? "text-muted-foreground" : ""}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary ${
        danger ? "hover:text-danger-foreground" : "hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "danger";
}) {
  const valueTone =
    tone === "warning"
      ? "text-warning-foreground"
      : tone === "danger"
        ? "text-danger-foreground"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-xl font-semibold tracking-tight tabular-nums sm:text-2xl ${valueTone}`}
      >
        {value}
      </span>
    </div>
  );
}
