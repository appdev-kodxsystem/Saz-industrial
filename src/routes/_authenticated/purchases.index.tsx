import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gift, Package, Plus } from "lucide-react";
import { listPurchasesPage, type PurchaseOrderRow } from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { SearchBox, Pagination } from "@/components/inventory/TableControls";
import { DateFilter, useDateFilter } from "@/components/inventory/DateFilter";
import {
  DateCell,
  Kpi,
  KpiRow,
  TransactionTable,
  money,
  type TxColumn,
} from "@/components/inventory/TransactionTable";
import { ReceiptLink } from "@/components/inventory/ReceiptLink";
import { AddonBadge } from "@/components/inventory/AddonBadge";

export const Route = createFileRoute("/_authenticated/purchases/")({
  head: () => ({ meta: [{ title: "Purchases — SAZ Industrial" }] }),
  // Admin-only: purchase cost is on this page, and cost is what makes margin
  // derivable. Hiding the nav tab is not enough — an employee can type the URL —
  // so the route itself turns them away.
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: PurchasesPage,
});

const PAGE_SIZE = 10;

/**
 * Purchases, one row per purchase.
 *
 * This page used to list stock UNITS, so a supplier run of forty blades filled
 * four pages and the thing you actually wanted to see — what that run cost —
 * had to be added up by eye. A row is now the whole run; the units and their
 * individual prices are one click away on the detail page.
 */
function PurchasesPage() {
  const navigate = useNavigate();
  const { period, range, onChange } = useDateFilter("month");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // debounce the search box so each keystroke doesn't hit the API
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // any filter change resets to the first page
  useEffect(() => {
    setPage(1);
  }, [range.from, range.to, search]);

  const fetchPage = useServerFn(listPurchasesPage);
  const { data, isFetching } = useQuery({
    queryKey: ["purchases", "page", range.from, range.to, search, page],
    queryFn: () =>
      fetchPage({
        data: { page, pageSize: PAGE_SIZE, search, from: range.from, to: range.to },
      }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? {
    count: 0,
    totalSpend: 0,
    machinerySpend: 0,
    addonSpend: 0,
    units: 0,
  };

  const openDetail = (r: PurchaseOrderRow) =>
    navigate({ to: "/purchases/$purchaseId", params: { purchaseId: r.id } });

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Every supplier run, with what it cost and what came in"
        actions={
          <button
            onClick={() => navigate({ to: "/purchases/new" })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition active:scale-95"
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add Purchase</span>
          </button>
        }
      >
        <DateFilter period={period} range={range} onChange={onChange} />
      </PageHeader>

      <PageBody>
        <KpiRow>
          <Kpi label="Purchases" value={String(stats.count)} />
          <Kpi label="Total Spend" value={money(stats.totalSpend)} />
          <Kpi
            label="Avg Purchase"
            value={money(stats.count ? stats.totalSpend / stats.count : 0)}
          />
          <Kpi label="Units In" value={String(stats.units)} />
        </KpiRow>

        <div className="mb-4 flex justify-end">
          <SearchBox
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search supplier, product, or batch…"
          />
        </div>

        <div className="animate-in fade-in duration-300 ease-out">
          <TransactionTable
            rows={rows}
            columns={COLUMNS}
            onOpen={openDetail}
            empty={
              <p className="mt-10 text-center text-sm text-muted-foreground">
                {search
                  ? "No purchases match your search."
                  : "No purchases recorded in this period."}
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
      </PageBody>
    </>
  );
}

const COLUMNS: TxColumn<PurchaseOrderRow>[] = [
  { header: "Date", render: (r) => <DateCell iso={r.created_at} /> },
  {
    header: "Supplier / Items",
    render: (r) => (
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{r.supplier || "Unnamed supplier"}</span>
          {r.addon_unit_count > 0 && <AddonBadge />}
        </span>
        <span className="truncate text-xs text-muted-foreground">{r.item_summary}</span>
      </div>
    ),
  },
  {
    header: "Contents",
    render: (r) => (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {r.unit_count > 0 && (
          <span className="inline-flex items-center gap-1">
            <Package className="size-3.5" />
            {r.unit_count} unit{r.unit_count === 1 ? "" : "s"}
          </span>
        )}
        {r.addon_unit_count > 0 && (
          <span className="inline-flex items-center gap-1">
            <Gift className="size-3.5" />
            {r.addon_unit_count}
          </span>
        )}
        {r.total_units === 0 && <span className="text-muted-foreground/40">—</span>}
      </div>
    ),
  },
  {
    header: "Lines",
    align: "right",
    render: (r) => <span className="text-muted-foreground">{r.line_count}</span>,
  },
  {
    header: "Total",
    align: "right",
    render: (r) => (
      <div className="flex flex-col items-end">
        <span className="font-medium">{money(r.grand_total)}</span>
        {/* Machinery and add-on spend are tracked separately, so show the split
            whenever a run carried both — the total alone hides it. */}
        {r.addon_cost > 0 && r.total_cost > 0 && (
          <span className="text-xs text-muted-foreground">
            {money(r.total_cost)} + {money(r.addon_cost)}
          </span>
        )}
      </div>
    ),
  },
  { header: "Receipt", render: (r) => <ReceiptLink path={r.receipt_path} /> },
  {
    header: "In Stock",
    align: "right",
    render: (r) => (
      <span className={r.still_in_stock > 0 ? "text-success-foreground" : "text-muted-foreground"}>
        {r.still_in_stock} / {r.total_units}
      </span>
    ),
  },
];
