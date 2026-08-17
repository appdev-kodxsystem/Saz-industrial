import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listSalesPage,
  listPurchasesPage,
  type LedgerEntry,
  type LedgerStats,
} from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { relativeTime } from "@/lib/relative-time";
import { SearchBox, Pagination } from "@/components/inventory/TableControls";

const PAGE_SIZE = 10;
const EMPTY_STATS: LedgerStats = {
  count: 0,
  revenue: 0,
  profit: 0,
  totalSpend: 0,
  stillInStock: 0,
};

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 2,
});

export interface Column {
  header: string;
  align?: "left" | "right";
  render: (e: LedgerEntry) => React.ReactNode;
  className?: string;
}

export interface Kpi {
  label: string;
  value: (stats: LedgerStats) => string;
  tone?: "good" | "danger";
}

/** Purchases only: machinery and add-ons arrive on the same orders but are
 *  different shapes of thing (one row per unit vs one row per batch), so the
 *  page lets you look at either on its own. */
export type LedgerStream = "all" | "machinery" | "addon";

export interface LedgerConfig {
  title: string;
  subtitle: string;
  kind: "purchase" | "sale";
  empty: string;
  searchPlaceholder?: string;
  /** Show the machinery/add-ons toggle and send `stream` to the server. */
  streams?: boolean;
  kpis: Kpi[];
  columns: Column[];
  // optional detail drawer; when present, rows become clickable and open it
  renderDetail?: (args: {
    entry: LedgerEntry | null;
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }) => React.ReactNode;
}

// Map a ledger kind to its paginated server function.
const PAGE_FN = {
  sale: listSalesPage,
  purchase: listPurchasesPage,
} as const;

export function money(n: number) {
  return fmt.format(n || 0);
}

type Period = "day" | "week" | "month" | "year" | "all";
const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "Daily" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
  { id: "all", label: "All" },
];

// Inclusive lower bound (ms) for the current calendar day/week/month/year.
function periodStart(period: Period): number {
  if (period === "all") return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "day") return d.getTime();
  if (period === "week") {
    const day = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - day);
    return d.getTime();
  }
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), 0, 1).getTime(); // year
}

export function LedgerPage({ config }: { config: LedgerConfig }) {
  const [period, setPeriod] = useState<Period>("month");
  const [stream, setStream] = useState<LedgerStream>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<LedgerEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const openDetail = config.renderDetail
    ? (e: LedgerEntry) => {
        setSelected(e);
        setDetailOpen(true);
      }
    : undefined;

  // debounce the search box so each keystroke doesn't hit the API
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // any filter change resets to the first page
  useEffect(() => {
    setPage(1);
  }, [period, search, stream]);

  const fetchPage = useServerFn(PAGE_FN[config.kind]);
  const from = periodStart(period);
  const { data, isFetching } = useQuery({
    queryKey: [config.kind, "page", period, search, page, stream],
    queryFn: () =>
      fetchPage({
        data: {
          page,
          pageSize: PAGE_SIZE,
          search,
          from,
          // Only Purchases understands this. The sales validator is a plain
          // z.object, which drops unknown keys, so sending it there is inert —
          // but there is no reason to.
          ...(config.streams ? { stream } : {}),
        } as any,
      }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? EMPTY_STATS;

  return (
    <>
      <PageHeader title={config.title} subtitle={config.subtitle}>
        <div className="-mx-1 flex flex-wrap items-center gap-2 overflow-x-auto px-1">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
                period === p.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
              }`}
            >
              {p.label}
            </button>
          ))}

          {config.streams && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px bg-hairline" />
              {(
                [
                  { id: "all", label: "Everything" },
                  { id: "machinery", label: "Machinery" },
                  { id: "addon", label: "Add-ons" },
                ] as { id: LedgerStream; label: string }[]
              ).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStream(s.id)}
                  className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    stream === s.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </>
          )}
        </div>
      </PageHeader>

      <PageBody>
        <section className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {config.kpis.map((k) => (
            <div
              key={k.label}
              className="flex flex-col gap-1 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5"
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {k.label}
              </span>
              <span
                className={`text-xl font-semibold tracking-tight sm:text-2xl tabular-nums ${
                  k.tone === "good"
                    ? "text-success-foreground"
                    : k.tone === "danger"
                      ? "text-danger-foreground"
                      : "text-foreground"
                }`}
              >
                {k.value(stats)}
              </span>
            </div>
          ))}
        </section>

        <div className="mb-4 flex justify-end">
          <SearchBox
            value={searchInput}
            onChange={setSearchInput}
            placeholder={config.searchPlaceholder ?? "Search…"}
          />
        </div>

        <div className="animate-in fade-in duration-300 ease-out">
          {rows.length === 0 ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">
              {search ? "No results match your search." : config.empty}
            </p>
          ) : (
            <>
              {/* Table — md and up */}
              <div className="hidden overflow-x-auto rounded-2xl bg-surface ring-1 ring-hairline md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                      {config.columns.map((c) => (
                        <th
                          key={c.header}
                          className={`px-4 py-3 font-medium ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}
                        >
                          {c.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr
                        key={`${e.kind}-${e.id}`}
                        onClick={openDetail ? () => openDetail(e) : undefined}
                        className={`border-b border-hairline last:border-0 hover:bg-surface-muted ${openDetail ? "cursor-pointer" : ""}`}
                      >
                        {config.columns.map((c) => (
                          <td
                            key={c.header}
                            className={`px-4 py-3 tabular-nums ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}
                          >
                            {c.render(e)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Cards — below md. Cols are [Date, Product, ...rest] in every config:
                show product + date in the header, the rest as label/value rows. */}
              <div className="flex flex-col gap-3 md:hidden">
                {rows.map((e) => {
                  const [dateCol, productCol, ...rest] = config.columns;
                  return (
                    <div
                      key={`${e.kind}-${e.id}`}
                      onClick={openDetail ? () => openDetail(e) : undefined}
                      className={`rounded-2xl bg-surface p-4 ring-1 ring-hairline ${openDetail ? "cursor-pointer active:bg-surface-muted" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3 border-b border-hairline pb-3">
                        <div className="min-w-0">{productCol.render(e)}</div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          {dateCol.render(e)}
                        </div>
                      </div>
                      <dl className="mt-3 flex flex-col gap-2">
                        {rest.map((c) => (
                          <div key={c.header} className="flex items-center justify-between gap-3">
                            <dt className="text-xs text-muted-foreground">{c.header}</dt>
                            <dd className="text-sm tabular-nums">{c.render(e)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPage={setPage}
            busy={isFetching}
          />
        </div>
      </PageBody>

      {config.renderDetail?.({ entry: selected, open: detailOpen, onOpenChange: setDetailOpen })}
    </>
  );
}

export function dateCell(e: LedgerEntry) {
  const d = new Date(e.date);
  return (
    <div className="flex flex-col">
      <span>
        {d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </span>
      <span className="text-xs text-muted-foreground">{relativeTime(e.date)}</span>
    </div>
  );
}

export function productCell(e: LedgerEntry) {
  return (
    <div className="flex flex-col">
      <span className="font-medium">{e.product_name}</span>
      <span className="text-xs text-muted-foreground">{e.sku}</span>
    </div>
  );
}
