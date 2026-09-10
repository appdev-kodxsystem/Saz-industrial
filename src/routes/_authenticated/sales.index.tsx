import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gift, Receipt, ScrollText, ShoppingCart, X } from "lucide-react";
import { listSalesPage, type SaleOrderRow } from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { SearchBox, Pagination } from "@/components/inventory/TableControls";
import { DateFilter, useDateFilter } from "@/components/inventory/DateFilter";
import {
  DateCell,
  Kpi,
  KpiRow,
  StatusPill,
  TransactionTable,
  money,
  type TxColumn,
} from "@/components/inventory/TransactionTable";
import { useTicket } from "@/components/sales/ticket-context";
import { PosTicket } from "@/components/sales/PosTicket";
import { ItemPicker } from "@/components/sales/ItemPicker";
import { useOrg } from "@/hooks/use-org";

export const Route = createFileRoute("/_authenticated/sales/")({
  head: () => ({ meta: [{ title: "Sales — SAZ Industrial" }] }),
  component: SalesPage,
});

type Tab = "sell" | "records";

/**
 * Sales: a till on the right, everything else on the left.
 *
 * The ticket panel is always open and always half the screen — this is the page
 * someone stands at all day, and a sale in progress should never be behind a
 * click. The left half is what you act on: items to sell, or the record of what
 * has already been sold.
 *
 * The ticket itself lives in the authenticated layout, so what is on screen
 * here is the SAME sale the dock shows on every other page — walking away and
 * coming back does not start a new one.
 */
function SalesPage() {
  const { isAdmin } = useOrg();
  const [tab, setTab] = useState<Tab>("sell");
  const t = useTicket();
  // Below `lg` there is no room for two panes, so the ticket becomes a sheet
  // over the picker, summoned by a bar pinned to the bottom of the screen.
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Sales"
        subtitle={isAdmin ? "Ring up a sale, or review what has been sold" : "Ring up a sale"}
      >
        <div className="flex items-center gap-1 self-start rounded-xl bg-surface p-1 ring-1 ring-hairline">
          <TabButton active={tab === "sell"} onClick={() => setTab("sell")}>
            <ShoppingCart className="size-4" />
            Sell
          </TabButton>
          <TabButton active={tab === "records"} onClick={() => setTab("records")}>
            <ScrollText className="size-4" />
            Records
          </TabButton>
        </div>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0">
          <PageBody className="lg:pr-0">
            {tab === "sell" ? <ItemPicker /> : <SalesRecords />}
          </PageBody>
        </div>

        {/* Half the screen, pinned directly under the page header and exactly as
            tall as what is left of the viewport. The panel itself never scrolls
            — its own line list does, between a fixed header and footer — so the
            total and the Complete button stay on screen no matter how long the
            ticket gets. The offset is measured, not guessed: this page's header
            carries a tab switcher and is taller than a bare one. */}
        <aside className="hidden lg:sticky lg:top-[var(--page-header-h,4rem)] lg:block lg:h-[calc(100dvh-var(--page-header-h,4rem))] lg:pb-6 lg:pr-8 lg:pt-8">
          <PosTicket canSeeCost={isAdmin} />
        </aside>
      </div>

      {/* --- small screens: a summary bar that opens the ticket full height --- */}
      <div className="sticky bottom-0 z-30 border-t border-hairline bg-background/95 p-3 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex h-12 w-full items-center gap-3 rounded-xl bg-primary px-4 text-primary-foreground transition active:scale-[0.99]"
        >
          <Receipt className="size-4 shrink-0" />
          <span className="text-sm font-semibold">
            {t.unitCount === 0
              ? "Ticket empty"
              : `${t.unitCount} unit${t.unitCount === 1 ? "" : "s"} on ticket`}
          </span>
          <span className="ml-auto text-sm font-semibold tabular-nums">{money(t.total)}</span>
        </button>
      </div>

      {sheetOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/60 backdrop-blur-sm lg:hidden">
          <button
            type="button"
            aria-label="Close the ticket"
            onClick={() => setSheetOpen(false)}
            className="h-16 w-full shrink-0"
          />
          <div className="relative min-h-0 flex-1 px-3 pb-3">
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              aria-label="Close the ticket"
              className="absolute -top-11 right-3 grid size-9 place-items-center rounded-full bg-surface ring-1 ring-hairline"
            >
              <X className="size-4" />
            </button>
            <PosTicket canSeeCost={isAdmin} onCompleted={() => setSheetOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

const PAGE_SIZE = 10;

/** The ledger half: one row per sale, click through for everything on it. */
function SalesRecords() {
  const navigate = useNavigate();
  const { isAdmin } = useOrg();
  const { period, range, onChange } = useDateFilter("month");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [range.from, range.to, search]);

  const fetchPage = useServerFn(listSalesPage);
  const { data, isFetching } = useQuery({
    queryKey: ["sales", "page", range.from, range.to, search, page],
    queryFn: () =>
      fetchPage({ data: { page, pageSize: PAGE_SIZE, search, from: range.from, to: range.to } }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? { count: 0, units: 0, revenue: 0, profit: 0, outstanding: 0 };

  return (
    <div>
      <div className="mb-4">
        <DateFilter period={period} range={range} onChange={onChange} />
      </div>

      {/* Two across, not four: this half of the screen is half as wide. */}
      <section className="mb-6 grid grid-cols-2 gap-3">
        <Kpi label="Sales" value={String(stats.count)} />
        <Kpi label="Revenue" value={money(stats.revenue)} />
        {isAdmin && (
          <>
            <Kpi label="Profit" value={money(stats.profit)} tone="good" />
            <Kpi
              label="Margin"
              value={`${stats.revenue > 0 ? ((stats.profit / stats.revenue) * 100).toFixed(1) : "0.0"}%`}
            />
          </>
        )}
        {!isAdmin && (
          <>
            <Kpi label="Units" value={String(stats.units)} />
            <Kpi label="Outstanding" value={money(stats.outstanding)} tone="warning" />
          </>
        )}
      </section>

      <div className="mb-4 flex justify-end">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search customer or product…"
        />
      </div>

      <div className="animate-in fade-in duration-300 ease-out">
        <TransactionTable
          rows={rows}
          columns={columnsFor(isAdmin)}
          onOpen={(r) => navigate({ to: "/sales/$saleId", params: { saleId: r.id } })}
          empty={
            <p className="mt-10 text-center text-sm text-muted-foreground">
              {search ? "No sales match your search." : "No sales recorded in this period."}
            </p>
          }
        />
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPage={setPage}
          busy={isFetching}
        />
      </div>
    </div>
  );
}

// Employees see the ledger but not cost, profit or margin — the same rule that
// keeps them off Purchases and Reports. The columns are dropped here AND the
// server zeroes those fields for them, so the numbers never reach the browser.
function columnsFor(canSeeCost: boolean): TxColumn<SaleOrderRow>[] {
  return [
    { header: "Date", render: (r) => <DateCell iso={r.created_at} /> },
    {
      header: "Customer / Items",
      render: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.customer_name || "Walk-in"}</span>
          <span className="truncate text-xs text-muted-foreground">{r.item_summary}</span>
        </div>
      ),
    },
    {
      header: "Units",
      align: "right",
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          {r.unit_count}
          {r.addon_units > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Gift className="size-3" />
              {r.addon_units}
            </span>
          )}
        </span>
      ),
    },
    {
      header: "Total",
      align: "right",
      render: (r) => <span className="font-medium">{money(r.total_amount)}</span>,
    },
    ...(canSeeCost
      ? [
          {
            header: "Profit",
            align: "right" as const,
            render: (r: SaleOrderRow) => (
              <span
                className={`font-medium ${r.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"}`}
              >
                {money(r.profit)}
              </span>
            ),
          },
        ]
      : []),
    {
      header: "Payment",
      align: "right",
      render: (r) =>
        r.pending_payment > 0 ? (
          <StatusPill tone="warning">{money(r.pending_payment)} due</StatusPill>
        ) : (
          <StatusPill tone="good">Paid</StatusPill>
        ),
    },
  ];
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-secondary"
      }`}
    >
      {children}
    </button>
  );
}
