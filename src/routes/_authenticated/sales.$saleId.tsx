import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ChevronDown, Gift, Paperclip, Phone, StickyNote, User } from "lucide-react";
import { getSaleDetail, type SaleDetailLine } from "@/lib/inventory.functions";
import { ReceiptLink } from "@/components/inventory/ReceiptLink";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { Kpi, KpiRow, StatusPill, money } from "@/components/inventory/TransactionTable";
import { RouteFallback } from "@/components/inventory/RouteFallback";
import { supabaseThumb } from "@/lib/img";
import { useOrg } from "@/hooks/use-org";

export const Route = createFileRoute("/_authenticated/sales/$saleId")({
  head: () => ({ meta: [{ title: "Sale — SAZ Industrial" }] }),
  component: SaleDetailPage,
});

/**
 * Everything recorded about one sale.
 *
 * Items are grouped the way the sale actually happened ("3 × Circular Saw"),
 * and expanding one shows each individual unit: its manufacture id, the exact
 * price it went out at, what it cost, and any add-ons handed over with it. A
 * line sold at mixed prices says so rather than showing an average.
 */
function SaleDetailPage() {
  const { saleId } = Route.useParams();
  const navigate = useNavigate();
  const { isAdmin } = useOrg();
  const fetchDetail = useServerFn(getSaleDetail);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sale", saleId],
    queryFn: () => fetchDetail({ data: { id: saleId } }),
  });

  if (isLoading) return <RouteFallback />;

  if (error || !data) {
    return (
      <>
        <PageHeader title="Sale" />
        <PageBody>
          <p className="mt-10 text-center text-sm text-danger-foreground">
            {error instanceof Error ? error.message : "This sale could not be loaded."}
          </p>
        </PageBody>
      </>
    );
  }

  const when = new Date(data.created_at);
  const margin = data.total_amount > 0 ? (data.profit / data.total_amount) * 100 : 0;

  return (
    <>
      <PageHeader
        title={data.customer_name || "Walk-in sale"}
        subtitle={`Sold ${when.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        })} at ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
        actions={
          <button
            onClick={() => navigate({ to: "/sales" })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-hairline transition hover:bg-accent active:scale-95"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Sales</span>
          </button>
        }
      />

      <PageBody>
        <KpiRow>
          <Kpi label="Sale Total" value={money(data.total_amount)} />
          <Kpi label="Units Sold" value={String(data.unit_count)} />
          {isAdmin ? (
            <>
              <Kpi
                label="Profit"
                value={money(data.profit)}
                tone={data.profit >= 0 ? "good" : "danger"}
              />
              <Kpi label="Margin" value={`${margin.toFixed(1)}%`} />
            </>
          ) : (
            <>
              <Kpi label="Paid" value={money(data.net_payment)} />
              <Kpi
                label="Outstanding"
                value={money(data.pending_payment)}
                tone={data.pending_payment > 0 ? "warning" : undefined}
              />
            </>
          )}
        </KpiRow>

        <section className="mb-6 flex flex-wrap items-start gap-x-8 gap-y-3 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <User className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{data.customer_name || "Walk-in"}</p>
              {data.customer_contact ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Phone className="size-3" />
                  {data.customer_contact}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">No contact recorded</p>
              )}
            </div>
          </div>

          <Field label="Items" value={`${data.line_count} · ${data.unit_count} units`} />
          <Field label="Paid" value={money(data.net_payment)} />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </span>
            {data.pending_payment > 0 ? (
              <StatusPill tone="warning">{money(data.pending_payment)} outstanding</StatusPill>
            ) : (
              <StatusPill tone="good">Paid in full</StatusPill>
            )}
          </div>

          {data.note && (
            <div className="flex w-full items-start gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
              <StickyNote className="mt-0.5 size-4 shrink-0" />
              <p className="whitespace-pre-wrap">{data.note}</p>
            </div>
          )}

          {data.receipt_path && (
            <div className="flex w-full items-center gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
              <Paperclip className="size-4 shrink-0" />
              <span>Attachment</span>
              <ReceiptLink path={data.receipt_path} />
            </div>
          )}
        </section>

        <h2 className="mb-3 text-sm font-semibold">What was sold</h2>
        <div className="flex flex-col gap-3">
          {data.lines.map((line, i) => (
            <LineCard key={line.product_id ?? i} line={line} canSeeCost={isAdmin} />
          ))}
          {!data.lines.length && (
            <p className="rounded-2xl bg-surface p-6 text-center text-sm text-muted-foreground ring-1 ring-hairline">
              This sale has no lines left on it.
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <div className="w-full rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:w-80 sm:p-5">
            <Row label="Sale total" value={money(data.total_amount)} />
            {isAdmin && (
              <>
                <Row label="Cost of goods" value={`−${money(data.cost)}`} muted />
                {data.addon_cost > 0 && (
                  <Row label="Add-ons given" value={`−${money(data.addon_cost)}`} muted />
                )}
              </>
            )}
            <Row label="Paid" value={money(data.net_payment)} />
            {data.pending_payment > 0 && (
              <Row label="Outstanding" value={money(data.pending_payment)} tone="danger" />
            )}
            {isAdmin && (
              <div className="mt-2 flex items-center justify-between border-t border-hairline pt-3">
                <span className="text-sm font-semibold">Profit</span>
                <span
                  className={`text-lg font-semibold tabular-nums ${
                    data.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"
                  }`}
                >
                  {money(data.profit)}
                </span>
              </div>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function LineCard({ line, canSeeCost }: { line: SaleDetailLine; canSeeCost: boolean }) {
  const [open, setOpen] = useState(false);
  const thumb = supabaseThumb(line.image_url, 96);
  const addonUnits = line.units.reduce(
    (n, u) => n + u.addons.reduce((m, a) => m + a.quantity, 0),
    0,
  );

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
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-xs font-semibold text-muted-foreground">
            {line.product_name.slice(0, 2).toUpperCase()}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{line.product_name}</p>
          <p className="flex items-center gap-2 truncate text-xs text-muted-foreground">
            {line.sku}
            {addonUnits > 0 && (
              <span className="inline-flex items-center gap-1">
                <Gift className="size-3" />
                {addonUnits}
              </span>
            )}
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
          {canSeeCost && (
            <p
              className={`text-xs tabular-nums ${line.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"}`}
            >
              {money(line.profit)} profit
            </p>
          )}
        </div>

        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-hairline bg-surface-muted/40 px-4 py-3 sm:px-5">
          <ul className="flex flex-col divide-y divide-hairline">
            {line.units.map((u, i) => (
              <li key={u.sale_id} className="py-2.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                      #{i + 1}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {u.manufacture_id ?? u.stock_item_id?.slice(0, 8) ?? "—"}
                    </span>
                    {u.pending_payment > 0 && (
                      <StatusPill tone="warning">{money(u.pending_payment)} due</StatusPill>
                    )}
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {money(u.selling_price)}
                    {canSeeCost && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        cost {money(u.cost)}
                      </span>
                    )}
                  </span>
                </div>

                {u.addons.length > 0 && (
                  <ul className="mt-1.5 flex flex-col gap-1 pl-8">
                    {u.addons.map((a, j) => (
                      <li
                        key={`${a.name}-${j}`}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        <Gift className="size-3 shrink-0" />
                        <span className="min-w-0 truncate">
                          {a.quantity} × {a.name}
                        </span>
                        {a.is_custom && (
                          <span className="rounded bg-secondary px-1 text-[10px]">custom</span>
                        )}
                        {canSeeCost && a.unit_cost > 0 && (
                          <span className="ml-auto shrink-0 tabular-nums">
                            −{money(a.unit_cost * a.quantity)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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

function Row({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: "danger";
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums ${tone === "danger" ? "text-danger-foreground" : muted ? "text-muted-foreground" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
