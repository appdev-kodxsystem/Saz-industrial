import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ChevronDown, Gift, Paperclip, Phone, StickyNote, User } from "lucide-react";
import { getSaleDetail, type SaleDetailLine } from "@/lib/inventory.functions";
import { ReceiptLink } from "@/components/inventory/ReceiptLink";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { StatusPill, money } from "@/components/inventory/TransactionTable";
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
        {/* An invoice shape: what was sold runs down the page, and everything
            ABOUT the sale — money, customer, paperwork — sits in a column
            beside it that stays put while a long list scrolls. The figures used
            to be stated twice, once as tiles across the top and again in a
            totals card at the bottom, with a dead quarter of the page between
            them. They are stated once, here. */}
        <div className="@container">
          <div className="grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0">
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
            </div>

            <aside className="flex flex-col gap-3 @4xl:sticky @4xl:top-[calc(var(--page-header-h,4rem)+1.5rem)]">
              <section className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Sale total
                </span>
                <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                  {money(data.total_amount)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {data.line_count} item{data.line_count === 1 ? "" : "s"} · {data.unit_count} unit
                  {data.unit_count === 1 ? "" : "s"}
                </p>

                {isAdmin && (
                  <div className="mt-4 border-t border-hairline pt-3">
                    <Row label="What it cost us" value={`−${money(data.cost)}`} muted />
                    {data.addon_cost > 0 && (
                      <Row label="Free add-ons given" value={`−${money(data.addon_cost)}`} muted />
                    )}
                    <div className="mt-2 flex items-baseline justify-between border-t border-hairline pt-3">
                      <span className="text-sm font-semibold">Profit</span>
                      <span className="text-right">
                        <span
                          className={`block text-lg font-semibold tabular-nums ${
                            data.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"
                          }`}
                        >
                          {money(data.profit)}
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {margin.toFixed(1)}% margin
                        </span>
                      </span>
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Payment
                  </span>
                  {data.pending_payment > 0 ? (
                    <StatusPill tone="warning">{money(data.pending_payment)} due</StatusPill>
                  ) : (
                    <StatusPill tone="good">Paid in full</StatusPill>
                  )}
                </div>
                <div className="mt-2">
                  <Row label="Customer paid" value={money(data.net_payment)} />
                  {data.pending_payment > 0 && (
                    <Row label="Still owed" value={money(data.pending_payment)} tone="danger" />
                  )}
                </div>
              </section>

              <section className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <User className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {data.customer_name || "Walk-in"}
                    </p>
                    {data.customer_contact ? (
                      <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <Phone className="size-3 shrink-0" />
                        {data.customer_contact}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No contact recorded</p>
                    )}
                  </div>
                </div>

                {data.note && (
                  <div className="mt-3 flex items-start gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
                    <StickyNote className="mt-0.5 size-4 shrink-0" />
                    <p className="whitespace-pre-wrap">{data.note}</p>
                  </div>
                )}

                {data.receipt_path && (
                  <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
                    <Paperclip className="size-4 shrink-0" />
                    <span>Attachment</span>
                    <ReceiptLink path={data.receipt_path} />
                  </div>
                )}
              </section>
            </aside>
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

        {/* Every figure says what it IS. "2 × PKR 234" and a bare "cost" read
            fine to whoever wrote them and to nobody else. */}
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground">
            {line.quantity} sold at{" "}
            {line.unit_price !== null ? (
              <span className="tabular-nums">{money(line.unit_price)} each</span>
            ) : (
              "different prices"
            )}
          </p>
          <p className="text-sm font-semibold tabular-nums">{money(line.total)}</p>
          {canSeeCost && (
            <p
              className={`text-xs tabular-nums ${
                line.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"
              }`}
            >
              {line.profit >= 0 ? "Profit" : "Loss"} {money(Math.abs(line.profit))}
            </p>
          )}
        </div>

        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-hairline bg-surface-muted/40 px-4 py-3 sm:px-5">
          {/* A column says what it holds once, at the top. Labelling every
              figure on every row said "Sale price" as many times as there were
              units and pushed the numbers into a ragged right edge; a header
              row says it once and lines the figures up underneath. */}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-2 text-left font-medium">Unit</th>
                <th className="pb-2 pl-6 text-right font-medium">Sale price</th>
                {canSeeCost && <th className="pb-2 pl-6 text-right font-medium">Purchase price</th>}
              </tr>
            </thead>
            <tbody>
              {line.units.map((u, i) => (
                <Fragment key={u.sale_id}>
                  <tr className="border-t border-hairline">
                    <td className="py-2.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
                          #{i + 1}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {u.manufacture_id ?? u.stock_item_id?.slice(0, 8) ?? "—"}
                        </span>
                        {u.pending_payment > 0 && (
                          <StatusPill tone="warning">
                            {money(u.pending_payment)} still owed
                          </StatusPill>
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 pl-6 text-right font-medium tabular-nums">
                      {money(u.selling_price)}
                    </td>
                    {canSeeCost && (
                      <td className="py-2.5 pl-6 text-right tabular-nums text-muted-foreground">
                        {money(u.cost)}
                      </td>
                    )}
                  </tr>

                  {u.addons.length > 0 && (
                    <tr>
                      <td colSpan={canSeeCost ? 3 : 2} className="pb-2.5 pl-8">
                        <ul className="flex flex-col gap-1">
                          {u.addons.map((a, j) => (
                            <li
                              key={`${a.name}-${j}`}
                              className="flex items-center gap-2 text-xs text-muted-foreground"
                            >
                              <Gift className="size-3 shrink-0" />
                              <span className="min-w-0 truncate">
                                {a.quantity} × {a.name} given free
                              </span>
                              {a.is_custom && (
                                <span className="rounded bg-secondary px-1 text-[10px]">
                                  custom
                                </span>
                              )}
                              {canSeeCost && a.unit_cost > 0 && (
                                <span className="ml-auto shrink-0 tabular-nums">
                                  cost {money(a.unit_cost * a.quantity)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
