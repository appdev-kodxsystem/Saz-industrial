"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getSaleDetail, type LedgerEntry } from "@/lib/inventory.functions";
import { money } from "@/components/inventory/LedgerPage";
import { relativeTime } from "@/lib/relative-time";

// Detail drawer for one sale row in the Sales ledger. `entry` carries the id +
// snapshot from the table; full detail (customer, payment split, cost/profit) is
// fetched lazily once the drawer opens.
export function SaleDetailDrawer({
  entry,
  open,
  onOpenChange,
}: {
  entry: LedgerEntry | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const fetchDetail = useServerFn(getSaleDetail);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["sale", "detail", entry?.id],
    queryFn: () => fetchDetail({ data: { id: entry!.id } }),
    enabled: open && !!entry?.id,
  });

  const dateLabel = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  const paid = data ? data.payment_status === "completed" : false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
        <SheetHeader className="border-b border-hairline p-6">
          <SheetTitle className="text-base font-semibold">Sale detail</SheetTitle>
        </SheetHeader>

        {/* header card uses the table snapshot so it paints instantly */}
        <div className="flex items-center gap-3 border-b border-hairline p-6">
          {data?.image_url ? (
            <img
              src={data.image_url}
              alt={data.product_name}
              className="h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-hairline"
            />
          ) : null}
          <div className="min-w-0">
            <div className="truncate font-medium">{entry?.product_name ?? "—"}</div>
            <div className="text-xs text-muted-foreground">SKU {entry?.sku ?? "—"}</div>
            {entry?.date ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {dateLabel(entry.date)} • {relativeTime(entry.date)}
              </div>
            ) : null}
          </div>
        </div>

        {isError ? (
          <p className="p-6 text-sm text-danger-foreground">Failed to load sale detail.</p>
        ) : !data && isFetching ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : data ? (
          <div className="flex flex-col gap-6 p-6">
            {/* payment status */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Status
              </span>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  paid
                    ? "bg-success/10 text-success-foreground"
                    : "bg-danger/10 text-danger-foreground"
                }`}
              >
                {paid ? "Paid" : "Pending"}
              </span>
            </div>

            {/* money */}
            <Section title="Payment">
              <Row label="Selling price" value={money(data.selling_price)} />
              <Row label="Net received" value={money(data.net_payment)} />
              <Row
                label="Pending"
                value={money(data.pending_payment)}
                tone={data.pending_payment > 0 ? "danger" : undefined}
              />
            </Section>

            {/* profit */}
            <Section title="Profit">
              <Row label="Cost" value={money(data.cost)} muted />
              <Row label="Selling price" value={money(data.selling_price)} muted />
              <Row
                label="Profit"
                value={money(data.profit)}
                tone={data.profit >= 0 ? "good" : "danger"}
              />
              <Row
                label="Margin"
                value={`${
                  data.selling_price > 0
                    ? ((data.profit / data.selling_price) * 100).toFixed(1)
                    : "0.0"
                }%`}
                muted
              />
            </Section>

            {/* customer */}
            <Section title="Customer">
              <Row label="Name" value={data.customer_name || "—"} />
              <Row label="Contact" value={data.customer_contact || "—"} />
            </Section>

            {/* unit */}
            <Section title="Unit">
              <Row label="Manufacture id" value={data.manufacture_id || "—"} />
            </Section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      <dl className="flex flex-col gap-2 rounded-2xl bg-surface-muted p-4">{children}</dl>
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
  tone?: "good" | "danger";
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={`text-sm tabular-nums ${
          tone === "good"
            ? "font-medium text-success-foreground"
            : tone === "danger"
              ? "font-medium text-danger-foreground"
              : muted
                ? "text-muted-foreground"
                : "font-medium"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export default SaleDetailDrawer;
