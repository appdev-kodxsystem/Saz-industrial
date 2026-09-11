import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ChevronDown, Gift, Package, Paperclip, StickyNote, Truck } from "lucide-react";
import { getPurchaseDetail, type PurchaseDetailLine } from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { StatusPill, money } from "@/components/inventory/TransactionTable";
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
        {/* Same shape as a sale: the goods run down the page, the money and the
            paperwork sit in a column beside them. Machinery and add-on spend
            stay split — they are tracked apart on purpose, and one merged
            number hides which half of a run was giveaways. */}
        <div className="@container">
          <div className="grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0">
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
            </div>

            <aside className="flex flex-col gap-3 @4xl:sticky @4xl:top-[calc(var(--page-header-h,4rem)+1.5rem)]">
              <section className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Purchase total
                </span>
                <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                  {money(data.grand_total)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {data.total_units} unit{data.total_units === 1 ? "" : "s"} ·{" "}
                  {money(data.total_units ? data.grand_total / data.total_units : 0)} each on
                  average
                </p>

                <div className="mt-4 border-t border-hairline pt-3">
                  {data.total_cost > 0 && (
                    <Row
                      label={`Machinery · ${data.unit_count} unit${data.unit_count === 1 ? "" : "s"}`}
                      value={money(data.total_cost)}
                    />
                  )}
                  {data.addon_cost > 0 && (
                    <Row
                      label={`Add-ons · ${data.addon_unit_count} unit${
                        data.addon_unit_count === 1 ? "" : "s"
                      }`}
                      value={money(data.addon_cost)}
                    />
                  )}
                </div>
              </section>

              <section className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Still in stock
                  </span>
                  {/* What is left of this run is the question a purchase gets
                      re-opened for: it says whether the money came back. */}
                  <StatusPill tone={data.still_in_stock > 0 ? "good" : "muted"}>
                    {data.still_in_stock} / {data.total_units}
                  </StatusPill>
                </div>
                <div className="mt-2">
                  <Row
                    label="Sold on"
                    value={`${data.total_units - data.still_in_stock} unit${
                      data.total_units - data.still_in_stock === 1 ? "" : "s"
                    }`}
                  />
                </div>
              </section>

              <section className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <Truck className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {data.supplier || "Unnamed supplier"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {data.lines.length} line{data.lines.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>

                {data.note && (
                  <div className="mt-3 flex items-start gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
                    <StickyNote className="mt-0.5 size-4 shrink-0" />
                    <p className="whitespace-pre-wrap">{data.note}</p>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3 text-sm text-muted-foreground">
                  <Paperclip className="size-4 shrink-0" />
                  <span>Receipt</span>
                  <ReceiptLink path={data.receipt_path} />
                </div>
              </section>
            </aside>
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

        {/* The same plain wording the sale detail uses: a figure that does not
            say what it is has to be guessed at. */}
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground">
            {line.quantity} bought at{" "}
            {line.unit_price !== null ? (
              <span className="tabular-nums">{money(line.unit_price)} each</span>
            ) : (
              "different prices"
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
          {/* Columns headed once, figures aligned under them — the same shape
              the sale detail uses, so the two pages read the same way. */}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-2 text-left font-medium">{isAddon ? "Batch" : "Machine"}</th>
                <th className="pb-2 pl-6 text-right font-medium">
                  {isAddon ? "Cost each" : "Purchase price"}
                </th>
                {isAddon && <th className="pb-2 pl-6 text-right font-medium">Batch cost</th>}
              </tr>
            </thead>
            <tbody>
              {line.units.map((u) => (
                <tr key={u.id} className="border-t border-hairline">
                  <td className="py-2.5">
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
                  </td>
                  <td className="py-2.5 pl-6 text-right font-medium tabular-nums">
                    {money(u.unit_price)}
                  </td>
                  {isAddon && (
                    <td className="py-2.5 pl-6 text-right tabular-nums text-muted-foreground">
                      {money(u.unit_price * (u.quantity ?? 0))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
