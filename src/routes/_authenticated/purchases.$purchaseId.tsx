import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ChevronDown, Gift, Package, StickyNote } from "lucide-react";
import { getPurchaseDetail, type PurchaseDetailLine } from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { Kpi, KpiRow, StatusPill, money } from "@/components/inventory/TransactionTable";
import { AddonBadge } from "@/components/inventory/AddonBadge";
import { supabaseThumb } from "@/lib/img";
import { ReceiptLink } from "@/components/inventory/ReceiptLink";
import { RouteFallback } from "@/components/inventory/RouteFallback";

export const Route = createFileRoute("/_authenticated/purchases/$purchaseId")({
  head: () => ({ meta: [{ title: "Purchase — SAZ Industrial" }] }),
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: PurchaseDetailPage,
});

/**
 * Everything recorded about one purchase.
 *
 * Each item is a line with its quantity and total; expanding it shows the
 * individual units, their manufacture ids and the exact price each one was
 * bought at. A line bought at mixed rates says so rather than showing an
 * average — the average is not a price anything was actually bought at, and
 * the real ones are one click below.
 */
function PurchaseDetailPage() {
  const { purchaseId } = Route.useParams();
  const navigate = useNavigate();
  const fetchDetail = useServerFn(getPurchaseDetail);

  const { data, isLoading, error } = useQuery({
    queryKey: ["purchase", purchaseId],
    queryFn: () => fetchDetail({ data: { id: purchaseId } }),
  });

  if (isLoading) return <RouteFallback />;

  if (error || !data) {
    return (
      <>
        <PageHeader title="Purchase" />
        <PageBody>
          <p className="mt-10 text-center text-sm text-danger-foreground">
            {error instanceof Error ? error.message : "This purchase could not be loaded."}
          </p>
        </PageBody>
      </>
    );
  }

  const when = new Date(data.created_at);

  return (
    <>
      <PageHeader
        title={data.supplier || "Unnamed supplier"}
        subtitle={`Purchased ${when.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        })} at ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
        actions={
          <button
            onClick={() => navigate({ to: "/purchases" })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-hairline transition hover:bg-accent active:scale-95"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Purchases</span>
          </button>
        }
      />

      <PageBody>
        <KpiRow>
          <Kpi label="Total Cost" value={money(data.grand_total)} />
          <Kpi label="Units Received" value={String(data.total_units)} />
          <Kpi label="Still In Stock" value={`${data.still_in_stock} / ${data.total_units}`} />
          <Kpi
            label="Avg Unit Cost"
            value={money(data.total_units ? data.grand_total / data.total_units : 0)}
          />
        </KpiRow>

        {/* Machinery and add-on spend are deliberately tracked apart, so a run
            that carried both shows the split rather than one merged number. */}
        {data.total_cost > 0 && data.addon_cost > 0 && (
          <div className="mb-6 flex flex-wrap gap-3">
            <SplitCard
              icon={<Package className="size-4" />}
              label="Machinery"
              amount={data.total_cost}
              units={data.unit_count}
            />
            <SplitCard
              icon={<Gift className="size-4" />}
              label="Add-ons"
              amount={data.addon_cost}
              units={data.addon_unit_count}
            />
          </div>
        )}

        <section className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
          <Field label="Supplier" value={data.supplier || "—"} />
          <Field
            label="Items"
            value={`${data.lines.length} line${data.lines.length === 1 ? "" : "s"}`}
          />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Receipt
            </span>
            <div className="-ml-2">
              <ReceiptLink path={data.receipt_path} />
            </div>
          </div>
          {data.note && (
            <div className="flex w-full items-start gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
              <StickyNote className="mt-0.5 size-4 shrink-0" />
              <p className="whitespace-pre-wrap">{data.note}</p>
            </div>
          )}
        </section>

        <h2 className="mb-3 text-sm font-semibold">What was purchased</h2>
        <div className="flex flex-col gap-3">
          {data.lines.map((line, i) => (
            <LineCard key={`${line.kind}-${line.item_id ?? i}`} line={line} />
          ))}
          {!data.lines.length && (
            <p className="rounded-2xl bg-surface p-6 text-center text-sm text-muted-foreground ring-1 ring-hairline">
              This purchase has no items left on it — the products it brought in were deleted.
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <div className="w-full rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:w-80 sm:p-5">
            <Row label="Machinery" value={money(data.total_cost)} />
            <Row label="Add-ons" value={money(data.addon_cost)} />
            <div className="mt-2 flex items-center justify-between border-t border-hairline pt-3">
              <span className="text-sm font-semibold">Purchase total</span>
              <span className="text-lg font-semibold tabular-nums">{money(data.grand_total)}</span>
            </div>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function LineCard({ line }: { line: PurchaseDetailLine }) {
  const [open, setOpen] = useState(false);
  const isAddon = line.kind === "addon";
  const thumb = supabaseThumb(line.image_url, 96);

  return (
    <div className="overflow-hidden rounded-2xl bg-surface ring-1 ring-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-surface-muted sm:p-5"
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="size-10 shrink-0 rounded-xl object-cover ring-1 ring-hairline"
          />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground">
            {isAddon ? <Gift className="size-4" /> : <Package className="size-4" />}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-medium">
            <span className="truncate">{line.name}</span>
            {isAddon && <AddonBadge />}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {line.sku}
            {isAddon && " · batch"}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-sm tabular-nums">
            {line.quantity} ×{" "}
            {line.unit_price !== null ? (
              money(line.unit_price)
            ) : (
              <span className="text-muted-foreground">mixed</span>
            )}
          </p>
          <p className="text-sm font-semibold tabular-nums">{money(line.total)}</p>
        </div>

        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-hairline bg-surface-muted/40 px-4 py-3 sm:px-5">
          <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>{isAddon ? "Batch" : "Manufacture ID"}</span>
            <span>Unit price</span>
          </div>
          <ul className="flex flex-col divide-y divide-hairline">
            {line.units.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {u.reference}
                  </span>
                  {isAddon ? (
                    <StatusPill tone={u.remaining ? "good" : "muted"}>
                      {u.remaining} of {u.quantity} left
                    </StatusPill>
                  ) : (
                    <StatusPill tone={u.sold ? "muted" : "good"}>
                      {u.sold ? "Sold" : "In stock"}
                    </StatusPill>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  {money(u.unit_price)}
                  {isAddon && (u.quantity ?? 0) > 1 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      = {money(u.unit_price * (u.quantity ?? 0))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SplitCard({
  icon,
  label,
  amount,
  units,
}: {
  icon: React.ReactNode;
  label: string;
  amount: number;
  units: number;
}) {
  return (
    <div className="flex flex-1 items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-hairline">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {label} · {units} unit{units === 1 ? "" : "s"}
        </p>
        <p className="font-semibold tabular-nums">{money(amount)}</p>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
