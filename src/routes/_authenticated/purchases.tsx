import { createFileRoute, redirect } from "@tanstack/react-router";
import { Gift } from "lucide-react";
import { LedgerPage, dateCell, money, type LedgerConfig } from "@/components/inventory/LedgerPage";
import { ReceiptLink } from "@/components/inventory/ReceiptLink";

export const Route = createFileRoute("/_authenticated/purchases")({
  head: () => ({ meta: [{ title: "Purchases — SAZ Industrial" }] }),
  // Admin-only: purchase cost per unit is on this page, and cost is what makes
  // margin derivable. Hiding the nav tab is not enough — an employee can type
  // the URL — so the route itself turns them away.
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: () => <LedgerPage config={config} />,
});

const config: LedgerConfig = {
  title: "Purchases",
  subtitle: "Stock you bought in — machinery by the unit, add-ons by the batch",
  kind: "purchase",
  empty: "No purchases recorded yet.",
  searchPlaceholder: "Search by product, SKU, or batch…",
  streams: true,
  kpis: [
    { label: "Purchases", value: (s) => String(s.count) },
    { label: "Total Spend", value: (s) => money(s.totalSpend) },
    {
      label: "Avg Line",
      value: (s) => money(s.count ? s.totalSpend / s.count : 0),
    },
    { label: "Units In Stock", value: (s) => String(s.stillInStock) },
  ],
  columns: [
    { header: "Date", render: dateCell },
    {
      header: "Item",
      render: (e) => (
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 font-medium">
            {/* An add-on row is a batch, not a unit — mark it so the two
                shapes on this page never get read as the same thing. */}
            {e.stream === "addon" && <Gift className="size-3.5 shrink-0 text-muted-foreground" />}
            {e.product_name}
            {e.stream === "addon" && (e.quantity ?? 0) > 1 && (
              <span className="text-xs font-normal text-muted-foreground">×{e.quantity}</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{e.sku}</span>
        </div>
      ),
    },
    {
      header: "Batch / Mfr ID",
      render: (e) => <span className="font-mono text-xs text-muted-foreground">{e.reference}</span>,
    },
    {
      header: "Cost",
      align: "right",
      render: (e) => (
        <div className="flex flex-col items-end">
          <span>{money(e.amount)}</span>
          {e.stream === "addon" && (e.quantity ?? 0) > 1 && (
            <span className="text-xs text-muted-foreground">{money(e.cost)} / unit</span>
          )}
        </div>
      ),
    },
    { header: "Receipt", render: (e) => <ReceiptLink path={e.receipt_path} /> },
    {
      header: "Status",
      align: "right",
      render: (e) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-hairline ${
            e.sold ? "text-muted-foreground" : "text-success-foreground"
          }`}
        >
          {e.stream === "addon"
            ? e.sold
              ? "All given"
              : "In stock"
            : e.sold
              ? "Sold"
              : "In stock"}
        </span>
      ),
    },
  ],
};
