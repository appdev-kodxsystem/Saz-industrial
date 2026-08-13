import { createFileRoute, redirect } from "@tanstack/react-router";
import { LedgerPage, dateCell, productCell, money, type LedgerConfig } from "@/components/inventory/LedgerPage";
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
  subtitle: "Stock you bought in, with cost per unit",
  kind: "purchase",
  empty: "No purchases recorded yet.",
  searchPlaceholder: "Search by product, SKU, or batch…",
  kpis: [
    { label: "Purchases", value: (s) => String(s.count) },
    { label: "Total Spend", value: (s) => money(s.totalSpend) },
    {
      label: "Avg Price",
      value: (s) => money(s.count ? s.totalSpend / s.count : 0),
    },
    { label: "Still In Stock", value: (s) => String(s.stillInStock) },
  ],
  columns: [
    { header: "Date", render: dateCell },
    { header: "Product", render: productCell },
    { header: "Batch / Mfr ID", render: (e) => <span className="text-muted-foreground">{e.reference}</span> },
    { header: "Purchase Price", align: "right", render: (e) => money(e.amount) },
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
          {e.sold ? "Sold" : "In stock"}
        </span>
      ),
    },
  ],
};
