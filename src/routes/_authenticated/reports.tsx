import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TrendingUp } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { getProfitSeries, type ProfitSaleRow } from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { PrintReportDialog } from "@/components/inventory/PrintReportDialog";
import { DateFilter, rangeLabel, useDateFilter } from "@/components/inventory/DateFilter";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Reports — SAZ Industrial" },
      { name: "description", content: "Weekly, monthly, and yearly profit reports." },
    ],
  }),
  // Admin-only, same reasoning as Purchases: this page is profit and margin.
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/inventory" });
  },
  component: ReportsPage,
});

type RangeKind = "daily" | "weekly" | "monthly" | "yearly";
const RANGES: { id: RangeKind; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "yearly", label: "Yearly" },
];

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});
const fmtFull = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 2,
});

interface Bucket {
  label: string;
  start: number;
  end: number;
  revenue: number;
  cost: number;
  profit: number;
  count: number;
}

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

// Build empty, chronologically-ordered buckets for the selected range.
function buildBuckets(kind: RangeKind): Bucket[] {
  const now = new Date();
  const out: Bucket[] = [];

  if (kind === "daily") {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const start = new Date(today);
      start.setDate(start.getDate() - i);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const label = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      out.push({
        label,
        start: start.getTime(),
        end: end.getTime(),
        revenue: 0,
        cost: 0,
        profit: 0,
        count: 0,
      });
    }
  } else if (kind === "weekly") {
    const thisWeek = startOfWeek(now);
    const WEEKS = 8;
    for (let i = WEEKS - 1; i >= 0; i--) {
      const start = new Date(thisWeek);
      start.setDate(start.getDate() - i * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const label = `Week ${WEEKS - i}`;
      out.push({
        label,
        start: start.getTime(),
        end: end.getTime(),
        revenue: 0,
        cost: 0,
        profit: 0,
        count: 0,
      });
    }
  } else if (kind === "monthly") {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = start.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      out.push({
        label,
        start: start.getTime(),
        end: end.getTime(),
        revenue: 0,
        cost: 0,
        profit: 0,
        count: 0,
      });
    }
  } else {
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear() - i, 0, 1);
      const end = new Date(now.getFullYear() - i + 1, 0, 1);
      out.push({
        label: String(start.getFullYear()),
        start: start.getTime(),
        end: end.getTime(),
        revenue: 0,
        cost: 0,
        profit: 0,
        count: 0,
      });
    }
  }
  return out;
}

/**
 * Divide a hand-picked range into a readable number of buckets.
 *
 * The fixed ranges know their own shape ("last 12 months"); a custom range does
 * not, so the unit is chosen from how long it is — a fortnight reads best by
 * day, two years by month. Anything else produces either one fat bar or three
 * hundred hairlines.
 */
function buildCustomBuckets(from: number, to: number): Bucket[] {
  const out: Bucket[] = [];
  if (!from || !to || to <= from) return out;
  const days = (to - from) / 86_400_000;
  const blank = { revenue: 0, cost: 0, profit: 0, count: 0 };

  if (days <= 31) {
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    while (cur.getTime() < to) {
      const start = new Date(cur);
      const end = new Date(cur);
      end.setDate(end.getDate() + 1);
      out.push({
        label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        start: start.getTime(),
        end: end.getTime(),
        ...blank,
      });
      cur.setDate(cur.getDate() + 1);
    }
  } else if (days <= 182) {
    const cur = startOfWeek(new Date(from));
    while (cur.getTime() < to) {
      const start = new Date(cur);
      const end = new Date(cur);
      end.setDate(end.getDate() + 7);
      out.push({
        label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        start: start.getTime(),
        end: end.getTime(),
        ...blank,
      });
      cur.setDate(cur.getDate() + 7);
    }
  } else {
    const first = new Date(from);
    const cur = new Date(first.getFullYear(), first.getMonth(), 1);
    while (cur.getTime() < to) {
      const start = new Date(cur);
      const end = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      out.push({
        label: start.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
        start: start.getTime(),
        end: end.getTime(),
        ...blank,
      });
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  return out;
}

function bucketize(sales: ProfitSaleRow[], kind: RangeKind, custom?: Bucket[]): Bucket[] {
  const buckets = custom?.length ? custom : buildBuckets(kind);
  if (!buckets.length) return buckets;
  const min = buckets[0].start;
  const max = buckets[buckets.length - 1].end;
  for (const s of sales) {
    const t = new Date(s.created_at).getTime();
    if (isNaN(t) || t < min || t >= max) continue;
    // linear scan is fine (<= 12 buckets)
    const b = buckets.find((bk) => t >= bk.start && t < bk.end);
    if (!b) continue;
    b.revenue += s.selling_price;
    b.cost += s.cost;
    b.profit += s.profit;
    b.count += 1;
  }
  return buckets;
}

function ReportsPage() {
  const [range, setRange] = useState<RangeKind>("monthly");
  // The preset chips answer "how do I want this bucketed"; the date filter
  // answers "over what window". A custom window takes over both, because a
  // hand-picked range has no natural bucket size of its own.
  const { period, range: dates, onChange } = useDateFilter("all");
  const isCustom = period === "custom";
  const profitSeries = useServerFn(getProfitSeries);

  const { data: sales = [] } = useQuery({
    queryKey: ["profit-series", isCustom ? dates.from : 0, isCustom ? dates.to : 0],
    queryFn: () =>
      profitSeries({ data: isCustom ? { from: dates.from, to: dates.to } : { from: 0, to: 0 } }),
    refetchInterval: 15_000, // real-time-ish: poll every 15s
    refetchOnWindowFocus: true,
  });

  const customBuckets = useMemo(
    () => (isCustom ? buildCustomBuckets(dates.from, dates.to) : []),
    [isCustom, dates.from, dates.to],
  );

  const buckets = useMemo(
    () => bucketize(sales, range, customBuckets),
    [sales, range, customBuckets],
  );

  const totals = useMemo(() => {
    const revenue = buckets.reduce((a, b) => a + b.revenue, 0);
    const cost = buckets.reduce((a, b) => a + b.cost, 0);
    const profit = buckets.reduce((a, b) => a + b.profit, 0);
    const count = buckets.reduce((a, b) => a + b.count, 0);
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    return { revenue, cost, profit, count, margin };
  }, [buckets]);

  const chartData = buckets.map((b) => ({
    label: b.label,
    profit: Math.round(b.profit * 100) / 100,
    revenue: Math.round(b.revenue * 100) / 100,
    cost: Math.round(b.cost * 100) / 100,
  }));

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Performance at a glance"
        actions={<PrintReportDialog />}
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* Bucket size — greyed out while a custom window drives it. */}
          <div
            className={`-mx-1 flex items-center gap-2 overflow-x-auto px-1 ${isCustom ? "pointer-events-none opacity-40" : ""}`}
          >
            {RANGES.map((r) => (
              <Chip key={r.id} active={range === r.id} onClick={() => setRange(r.id)}>
                {r.label}
              </Chip>
            ))}
          </div>
          <span aria-hidden className="mx-1 hidden h-4 w-px bg-hairline sm:block" />
          <DateFilter period={period} range={dates} onChange={onChange} />
        </div>
      </PageHeader>

      <PageBody>
        <section className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Kpi label="Revenue" value={fmt.format(totals.revenue)} />
          <Kpi label="Cost" value={fmt.format(totals.cost)} />
          <Kpi
            label="Profit"
            value={fmt.format(totals.profit)}
            tone={totals.profit >= 0 ? "good" : "danger"}
          />
          <Kpi label="Margin" value={`${totals.margin.toFixed(1)}%`} />
        </section>

        <section className="mb-6 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              Profit —{" "}
              {isCustom
                ? rangeLabel("custom", dates)
                : range === "daily"
                  ? "last 14 days"
                  : range === "weekly"
                    ? "last 8 weeks"
                    : range === "monthly"
                      ? "last 12 months"
                      : "last 6 years"}
            </h2>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  stroke="var(--muted-foreground)"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  stroke="var(--muted-foreground)"
                  width={56}
                  tickFormatter={(v) => fmt.format(Number(v))}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="profit"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fill="url(#profitFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Revenue vs Cost</h2>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  stroke="var(--muted-foreground)"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  stroke="var(--muted-foreground)"
                  width={56}
                  tickFormatter={(v) => fmt.format(Number(v))}
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="revenue" name="Revenue" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                <Bar
                  dataKey="cost"
                  name="Cost"
                  fill="var(--muted-foreground)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        {totals.count === 0 && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            No sales recorded in this period yet. Sell stock to populate reports.
          </p>
        )}
      </PageBody>
    </>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-hairline bg-background px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center justify-between gap-4 tabular-nums">
          <span className="capitalize text-muted-foreground">{p.name ?? p.dataKey}</span>
          <span className="font-medium">{fmtFull.format(Number(p.value) || 0)}</span>
        </p>
      ))}
    </div>
  );
}

function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "good" | "danger" }) {
  const valueTone =
    tone === "good"
      ? "text-success-foreground"
      : tone === "danger"
        ? "text-danger-foreground"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-xl font-semibold tracking-tight sm:text-2xl tabular-nums ${valueTone}`}
      >
        {value}
      </span>
    </div>
  );
}
