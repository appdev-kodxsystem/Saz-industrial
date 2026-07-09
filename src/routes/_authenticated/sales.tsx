import { createFileRoute } from "@tanstack/react-router";
import { LedgerPage, dateCell, productCell, money, type LedgerConfig } from "@/components/inventory/LedgerPage";
import { SaleDetailDrawer } from "@/components/inventory/SaleDetailDrawer";

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => ({ meta: [{ title: "Sales — SAZ Industrial" }] }),
  component: () => <LedgerPage config={config} />,
});

const config: LedgerConfig = {
  title: "Sales",
  subtitle: "Every unit sold, with revenue and profit",
  kind: "sale",
  empty: "No sales recorded yet.",
  searchPlaceholder: "Search by product or SKU…",
  kpis: [
    { label: "Sales", value: (s) => String(s.count) },
    { label: "Revenue", value: (s) => money(s.revenue) },
    { label: "Profit", value: (s) => money(s.profit), tone: "good" },
    {
      label: "Margin",
      value: (s) => `${s.revenue > 0 ? ((s.profit / s.revenue) * 100).toFixed(1) : "0.0"}%`,
    },
  ],
  columns: [
    { header: "Date", render: dateCell },
    { header: "Product", render: productCell },
    { header: "Sale Price", align: "right", render: (e) => money(e.amount) },
    { header: "Cost", align: "right", render: (e) => <span className="text-muted-foreground">{money(e.cost)}</span> },
    {
      header: "Profit",
      align: "right",
      render: (e) => (
        <span className={`font-medium ${e.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"}`}>
          {money(e.profit)}
        </span>
      ),
    },
  ],
  renderDetail: ({ entry, open, onOpenChange }) => (
    <SaleDetailDrawer entry={entry} open={open} onOpenChange={onOpenChange} />
  ),
};
