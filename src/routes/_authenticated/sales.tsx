import { createFileRoute } from "@tanstack/react-router";
import { LedgerPage, dateCell, productCell, money, type LedgerConfig } from "@/components/inventory/LedgerPage";
import { SaleDetailDrawer } from "@/components/inventory/SaleDetailDrawer";
import type { LedgerEntry, LedgerStats } from "@/lib/inventory.functions";
import { useOrg } from "@/hooks/use-org";

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => ({ meta: [{ title: "Sales — SAZ Industrial" }] }),
  component: SalesPage,
});

function SalesPage() {
  const { isAdmin } = useOrg();
  return <LedgerPage config={makeConfig(isAdmin)} />;
}

// Employees see the sales ledger but not cost, profit or margin — the same
// reasoning that keeps them off the Purchases and Reports pages. The columns and
// KPIs are dropped here, and the server (listSalesPage) also zeroes those fields
// for an employee, so the numbers never reach the browser in the first place.
function makeConfig(canSeeCost: boolean): LedgerConfig {
  return {
    title: "Sales",
    subtitle: canSeeCost ? "Every unit sold, with revenue and profit" : "Every unit sold",
    kind: "sale",
    empty: "No sales recorded yet.",
    searchPlaceholder: "Search by product or SKU…",
    kpis: [
      { label: "Sales", value: (s) => String(s.count) },
      { label: "Revenue", value: (s) => money(s.revenue) },
      ...(canSeeCost
        ? [
            { label: "Profit", value: (s: LedgerStats) => money(s.profit), tone: "good" as const },
            {
              label: "Margin",
              value: (s: LedgerStats) =>
                `${s.revenue > 0 ? ((s.profit / s.revenue) * 100).toFixed(1) : "0.0"}%`,
            },
          ]
        : []),
    ],
    columns: [
      { header: "Date", render: dateCell },
      { header: "Product", render: productCell },
      { header: "Sale Price", align: "right", render: (e: LedgerEntry) => money(e.amount) },
      ...(canSeeCost
        ? [
            {
              header: "Cost",
              align: "right" as const,
              render: (e: LedgerEntry) => (
                <span className="text-muted-foreground">{money(e.cost)}</span>
              ),
            },
            {
              header: "Profit",
              align: "right" as const,
              render: (e: LedgerEntry) => (
                <span
                  className={`font-medium ${e.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"}`}
                >
                  {money(e.profit)}
                </span>
              ),
            },
          ]
        : []),
    ],
    renderDetail: ({ entry, open, onOpenChange }) => (
      <SaleDetailDrawer entry={entry} open={open} onOpenChange={onOpenChange} canSeeCost={canSeeCost} />
    ),
  };
}
