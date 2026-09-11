import { createFileRoute, redirect } from "@tanstack/react-router";
import { money, moneyExact } from "@/lib/money";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDownRight, ArrowUpRight, Minus, Package, TrendingUp } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { getProfitSeries, type ProfitSaleRow } from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { PrintReportDialog } from "@/components/inventory/PrintReportDialog";
import {
  DateFilter,
  rangeLabel,
  TREND_PRESETS,
  useDateFilter,
  type PeriodId,
} from "@/components/inventory/DateFilter";

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

const num = new Intl.NumberFormat("en-US");
// Axis ticks only have to carry the ORDER of a number; the tooltip and the
// legend carry it exactly. Spelling "PKR 104,000" out in a 56px gutter is what
// clipped the labels to "00,000".
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// No negative left margin: it pulled the y-axis gutter under the plot, which is
// how an axis figure ends up sitting on top of the x-axis labels.
const CHART_MARGIN = { top: 8, right: 8, left: 0, bottom: 0 };
/**
 * Recharts hides ticks it thinks will collide, and it estimates that from the
 * widest label — which is what silently dropped three of twelve months. The
 * buckets were all there; the labels were not. So the decision is made here
 * instead: up to fourteen buckets, every one is labelled outright; past that
 * (a month by day, a day by hour) it thins them, because thirty-one labels
 * genuinely will not fit and a readable subset beats an unreadable smear.
 */
function xAxisFor(count: number) {
  return {
    dataKey: "label",
    tick: { fontSize: 11 },
    tickLine: false,
    axisLine: false,
    stroke: "var(--muted-foreground)",
    interval: count <= 14 ? 0 : ("preserveStartEnd" as const),
    minTickGap: count <= 14 ? 0 : 12,
    tickMargin: 8,
    height: 28,
  };
}
const Y_AXIS = {
  tick: { fontSize: 11 },
  tickLine: false,
  axisLine: false,
  stroke: "var(--muted-foreground)",
  // Wide enough for a negative compact figure ("-104K") plus its gap, so the
  // gutter never has to borrow space from the plot.
  width: 60,
  tickMargin: 6,
  tickFormatter: (v: number) => compact.format(Number(v)),
} as const;

const DAY = 86_400_000;

interface Bucket {
  label: string;
  start: number;
  end: number;
  revenue: number;
  cost: number;
  profit: number;
  count: number;
}

interface Totals {
  revenue: number;
  cost: number;
  profit: number;
  count: number;
  margin: number;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
}

/**
 * Divide the chosen window into a readable number of buckets.
 *
 * The unit is DERIVED from how long the window is rather than picked by hand:
 * a day reads by hour, a fortnight by day, half a year by week, longer by
 * month. Anything else produces either one fat bar or three hundred hairlines —
 * which is exactly why this page used to ask for the bucket size in a second
 * row of chips, and no longer needs to.
 */
function bucketsFor(
  from: number,
  to: number,
  // Hours are only ever the right unit when a single day was ASKED for. "All
  // time" on a shop that opened yesterday spans under two days, and deriving
  // the unit from that span alone turned a whole-history view into an hour-by-
  // hour one — technically the span, but not what was asked for.
  allowHourly: boolean,
): { buckets: Bucket[]; unit: string } {
  const blank = { revenue: 0, cost: 0, profit: 0, count: 0 };
  const out: Bucket[] = [];
  if (!from || !to || to <= from) return { buckets: out, unit: "" };
  const days = (to - from) / DAY;

  const push = (start: Date, end: Date, label: string) =>
    out.push({ label, start: start.getTime(), end: end.getTime(), ...blank });

  if (allowHourly && days <= 2) {
    const cur = new Date(from);
    cur.setMinutes(0, 0, 0);
    while (cur.getTime() < to) {
      const end = new Date(cur.getTime() + 3_600_000);
      push(new Date(cur), end, cur.toLocaleTimeString("en-US", { hour: "numeric" }));
      cur.setTime(end.getTime());
    }
    return { buckets: out, unit: "by hour" };
  }

  if (days <= 31) {
    const cur = startOfDay(new Date(from));
    while (cur.getTime() < to) {
      const end = new Date(cur);
      end.setDate(end.getDate() + 1);
      push(new Date(cur), end, cur.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      cur.setDate(cur.getDate() + 1);
    }
    return { buckets: out, unit: "by day" };
  }

  if (days <= 182) {
    const cur = startOfWeek(new Date(from));
    while (cur.getTime() < to) {
      const end = new Date(cur);
      end.setDate(end.getDate() + 7);
      push(new Date(cur), end, cur.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      cur.setDate(cur.getDate() + 7);
    }
    return { buckets: out, unit: "by week" };
  }

  const first = new Date(from);
  const cur = new Date(first.getFullYear(), first.getMonth(), 1);
  while (cur.getTime() < to) {
    const end = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    // Month alone. A rolling year is read as a sequence, and which calendar
    // year each end of it falls in is not the question being asked of the
    // chart — the window is named in the filter above it.
    push(new Date(cur), end, cur.toLocaleDateString("en-US", { month: "short" }));
    cur.setMonth(cur.getMonth() + 1);
  }
  return { buckets: out, unit: "by month" };
}

function fill(sales: ProfitSaleRow[], buckets: Bucket[]): Bucket[] {
  if (!buckets.length) return buckets;
  const min = buckets[0].start;
  const max = buckets[buckets.length - 1].end;
  for (const s of sales) {
    const t = new Date(s.created_at).getTime();
    if (isNaN(t) || t < min || t >= max) continue;
    const b = buckets.find((bk) => t >= bk.start && t < bk.end);
    if (!b) continue;
    b.revenue += s.selling_price;
    b.cost += s.cost;
    b.profit += s.profit;
    b.count += 1;
  }
  return buckets;
}

function totalsOf(sales: ProfitSaleRow[], from: number, to: number): Totals {
  let revenue = 0;
  let cost = 0;
  let profit = 0;
  let count = 0;
  for (const s of sales) {
    const t = new Date(s.created_at).getTime();
    if (isNaN(t) || t < from || t > to) continue;
    revenue += s.selling_price;
    cost += s.cost;
    profit += s.profit;
    count += 1;
  }
  return { revenue, cost, profit, count, margin: revenue > 0 ? (profit / revenue) * 100 : 0 };
}

/**
 * Reports: what the business earned, and off what.
 *
 * ONE filter. It used to carry two rows of chips — a bucket size (Daily /
 * Weekly / Monthly / Yearly) and a window (Today / Week / Month / Year / All) —
 * which overlapped in wording without overlapping in meaning, so "Monthly" and
 * "Month" sat next to each other meaning different things. The window is the
 * only question a reader actually has; the bucket size follows from it.
 *
 * Every figure is also shown against the period immediately before it. A number
 * on its own is a fact; the same number against last month is the thing anyone
 * actually wants to know.
 */
function ReportsPage() {
  const { period, range, onChange } = useDateFilter("month");
  const profitSeries = useServerFn(getProfitSeries);

  // Fetched whole and filtered here, because every window on this page is
  // compared against the one before it — and the previous period is, by
  // definition, outside whatever window the server was asked for.
  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["profit-series"],
    queryFn: () => profitSeries({ data: { from: 0, to: 0 } }),
    refetchInterval: 15_000, // real-time-ish: poll every 15s
    refetchOnWindowFocus: true,
  });

  // Every window this page offers has bounds of its own now. "All time" had
  // none — it had to borrow them from the data, which made its bucket size and
  // its comparison period depend on when the shop happened to open.
  const window = range;

  // Today is the one preset that means "within a day"; a custom range can be a
  // single day too, and there the span is genuinely what the user picked.
  const allowHourly = period === "day" || period === "custom";

  const { buckets, unit } = useMemo(() => {
    const built = bucketsFor(window.from, window.to, allowHourly);
    return { buckets: fill(sales, built.buckets), unit: built.unit };
  }, [sales, window.from, window.to, allowHourly]);

  const totals = useMemo(
    () => totalsOf(sales, window.from, window.to),
    [sales, window.from, window.to],
  );

  // The same length of time, ending where this window starts.
  const previous = useMemo(() => {
    const span = window.to - window.from;
    if (span <= 0) return null;
    return totalsOf(sales, window.from - span, window.from - 1);
  }, [sales, window.from, window.to]);

  const chartData = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        revenue: Math.round(b.revenue * 100) / 100,
        cost: Math.round(b.cost * 100) / 100,
        profit: Math.round(b.profit * 100) / 100,
        count: b.count,
      })),
    [buckets],
  );

  // What actually earned the money. Top six by profit, everything else folded
  // into one row rather than a scrolling list nobody reads to the bottom of.
  const products = useMemo(() => {
    const by = new Map<string, { name: string; profit: number; revenue: number; units: number }>();
    for (const s of sales) {
      const t = new Date(s.created_at).getTime();
      if (isNaN(t) || t < window.from || t > window.to) continue;
      const row = by.get(s.product_name) ?? {
        name: s.product_name,
        profit: 0,
        revenue: 0,
        units: 0,
      };
      row.profit += s.profit;
      row.revenue += s.selling_price;
      row.units += 1;
      by.set(s.product_name, row);
    }
    const all = [...by.values()].sort((a, b) => b.profit - a.profit);
    if (all.length <= 7) return all;
    const rest = all.slice(6);
    return [
      ...all.slice(0, 6),
      {
        name: `${rest.length} other products`,
        profit: rest.reduce((n, r) => n + r.profit, 0),
        revenue: rest.reduce((n, r) => n + r.revenue, 0),
        units: rest.reduce((n, r) => n + r.units, 0),
      },
    ];
  }, [sales, window.from, window.to]);

  const windowLabel = period === "custom" ? rangeLabel("custom", range) : periodLabel(period);
  const empty = !isLoading && totals.count === 0;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Performance at a glance"
        actions={<PrintReportDialog />}
      >
        {/* One control. The chart's bucket size is derived from whatever window
            this picks, and named on the chart itself. */}
        <DateFilter period={period} range={range} onChange={onChange} presets={TREND_PRESETS} />
      </PageHeader>

      <PageBody>
        {/* The headline, and the same period a period ago. */}
        <section className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-3 sm:gap-4">
          <div className="rounded-2xl bg-surface p-5 ring-1 ring-hairline">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Profit · {windowLabel}
            </span>
            <p
              className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl ${
                totals.profit >= 0 ? "text-foreground" : "text-danger-foreground"
              }`}
            >
              {money(totals.profit)}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <Delta now={totals.profit} before={previous?.profit} />
              <span className="text-muted-foreground">
                {totals.margin.toFixed(1)}% margin · {num.format(totals.count)} sale
                {totals.count === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <Kpi
            label="Revenue"
            value={money(totals.revenue)}
            swatch="var(--series-revenue)"
            delta={<Delta now={totals.revenue} before={previous?.revenue} />}
            hint={
              totals.count > 0 ? `${money(totals.revenue / totals.count)} average sale` : undefined
            }
          />
          <Kpi
            label="Cost"
            value={money(totals.cost)}
            swatch="var(--series-cost)"
            // Spending more is not automatically worse, so cost states its
            // change without calling it good or bad.
            delta={<Delta now={totals.cost} before={previous?.cost} neutral />}
            hint="stock sold, plus add-ons given away"
          />
        </section>

        {/* Two questions, two charts. They were drawn on top of each other —
            bars for revenue and cost with a profit line through them — which
            made the line look like it belonged to the same scale as the bars
            and buried the one figure a reader is looking for.
            Stacked rather than side by side: a year is twelve buckets, and half
            the page is not enough width for twelve labels — the axis was
            dropping three of them to fit. Full width fits all twelve, and one
            above the other still reads left-to-right on the same dates. */}
        <div className="mb-6 flex flex-col gap-4">
          <ChartCard
            title="Revenue and cost"
            unit={unit}
            legend={
              <>
                <LegendItem color="var(--series-revenue)" name="Revenue" value={totals.revenue} />
                <LegendItem color="var(--series-cost)" name="Cost" value={totals.cost} />
              </>
            }
            empty={empty}
          >
            <BarChart data={chartData} margin={CHART_MARGIN} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
              <XAxis {...xAxisFor(chartData.length)} />
              <YAxis {...Y_AXIS} />
              <Tooltip cursor={{ fill: "var(--hairline)" }} content={<ChartTooltip />} />
              <Bar
                dataKey="revenue"
                name="Revenue"
                fill="var(--series-revenue)"
                radius={[4, 4, 0, 0]}
                maxBarSize={26}
              />
              <Bar
                dataKey="cost"
                name="Cost"
                fill="var(--series-cost)"
                radius={[4, 4, 0, 0]}
                maxBarSize={26}
              />
            </BarChart>
          </ChartCard>

          <ChartCard
            title="Profit"
            unit={unit}
            legend={
              <span
                className={`text-sm font-semibold tabular-nums ${
                  totals.profit >= 0 ? "text-success-foreground" : "text-danger-foreground"
                }`}
              >
                {money(totals.profit)}
              </span>
            }
            empty={empty}
          >
            <AreaChart data={chartData} margin={CHART_MARGIN}>
              <defs>
                <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-profit)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--series-profit)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" vertical={false} />
              <XAxis {...xAxisFor(chartData.length)} />
              <YAxis {...Y_AXIS} />
              {/* Break-even. Without it, a chart that never crosses zero and
                    one that lives entirely below it look the same. */}
              <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeWidth={1} />
              <Tooltip cursor={{ stroke: "var(--hairline)" }} content={<ChartTooltip />} />
              <Area
                type="monotone"
                dataKey="profit"
                name="Profit"
                stroke="var(--series-profit)"
                strokeWidth={2}
                fill="url(#profitFill)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              />
            </AreaChart>
          </ChartCard>
        </div>

        {/* What earned it. The chart says when the money came in; this says what
            it came from — the question the old page could not answer at all. */}
        <section className="rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <Package className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Profit by product</h2>
            <span className="text-xs text-muted-foreground">{windowLabel}</span>
          </div>

          {products.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing sold in this period.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {products.map((p) => (
                <ProductRow
                  key={p.name}
                  name={p.name}
                  profit={p.profit}
                  revenue={p.revenue}
                  units={p.units}
                  // Bars are proportional to the biggest ABSOLUTE figure, so a
                  // loss-making product is as long as an equally large win.
                  max={Math.max(...products.map((r) => Math.abs(r.profit)), 1)}
                />
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </>
  );
}

/** One chart, its title, its own legend, and a fixed plot height so two of them
 *  sitting side by side line up date for date. */
function ChartCard({
  title,
  unit,
  legend,
  empty,
  children,
}: {
  title: string;
  unit: string;
  legend: React.ReactNode;
  empty: boolean;
  children: React.ReactElement;
}) {
  return (
    <section className="rounded-2xl bg-surface p-4 ring-1 ring-hairline sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">{legend}</div>
      </div>
      <div className="h-72 w-full">
        {empty ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

function periodLabel(period: PeriodId): string {
  const names: Record<string, string> = {
    day: "Today",
    week: "This week",
    month: "This month",
    year: "Last 12 months",
    all: "All time",
  };
  return names[period] ?? "This month";
}

/**
 * The same figure, one period ago.
 *
 * Growth from nothing is not a percentage — dividing by zero gives Infinity and
 * "+∞%" is not a report — so a period that started from zero says "new" and a
 * missing comparison says nothing at all rather than inventing 0%.
 */
function Delta({ now, before, neutral }: { now: number; before?: number; neutral?: boolean }) {
  if (before === undefined) return null;
  if (before === 0 && now === 0) return null;
  if (before === 0) {
    return <span className="text-xs font-medium text-muted-foreground">new this period</span>;
  }

  const pct = ((now - before) / Math.abs(before)) * 100;
  const up = pct > 0.05;
  const down = pct < -0.05;
  const tone = neutral
    ? "text-muted-foreground"
    : up
      ? "text-success-foreground"
      : down
        ? "text-danger-foreground"
        : "text-muted-foreground";
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums ${tone}`}>
      <Icon className="size-3.5" />
      {Math.abs(pct).toFixed(1)}%
      <span className="font-normal text-muted-foreground">vs previous</span>
    </span>
  );
}

function Kpi({
  label,
  value,
  hint,
  delta,
  swatch,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: React.ReactNode;
  swatch?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface p-5 ring-1 ring-hairline">
      <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {swatch && (
          <span aria-hidden className="size-2 rounded-full" style={{ background: swatch }} />
        )}
        {label}
      </span>
      <span className="text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</span>
      {delta}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function LegendItem({ color, name, value }: { color: string; name: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden className="size-2.5 rounded-sm" style={{ background: color }} />
      <span className="text-muted-foreground">{name}</span>
      <span className="font-medium tabular-nums">{money(value)}</span>
    </span>
  );
}

function ProductRow({
  name,
  profit,
  revenue,
  units,
  max,
}: {
  name: string;
  profit: number;
  revenue: number;
  units: number;
  max: number;
}) {
  const width = `${Math.max((Math.abs(profit) / max) * 100, 1.5)}%`;
  const loss = profit < 0;
  // Red/green alone is the one pairing a colour-blind reader cannot split, so
  // the signed amount above each bar is not decoration — it is what carries the
  // meaning when the colour does not.
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        <span
          className={`shrink-0 text-sm font-semibold tabular-nums ${
            loss ? "text-danger-foreground" : "text-success-foreground"
          }`}
        >
          {money(profit)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
          <div
            className="h-full rounded-full"
            style={{
              width,
              background: loss ? "var(--series-loss)" : "var(--series-profit)",
            }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {num.format(units)} unit{units === 1 ? "" : "s"} · {money(revenue)}
        </span>
      </div>
    </li>
  );
}

function EmptyChart() {
  return (
    <div className="grid h-full place-items-center rounded-xl bg-surface-muted/40 text-center">
      <p className="text-sm text-muted-foreground">Nothing sold in this period.</p>
    </div>
  );
}

interface TooltipPayloadItem {
  dataKey?: string | number;
  name?: string;
  value?: number | string;
  color?: string;
  payload?: { count?: number };
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const count = payload[0]?.payload?.count ?? 0;
  return (
    <div className="rounded-lg border border-hairline bg-background px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium">{label}</p>
      {payload.map((p) => (
        <p
          key={String(p.dataKey)}
          className="flex items-center justify-between gap-4 tabular-nums leading-5"
        >
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="size-2 rounded-sm" style={{ background: p.color }} />
            {p.name ?? String(p.dataKey)}
          </span>
          <span className="font-medium">{moneyExact(Number(p.value) || 0)}</span>
        </p>
      ))}
      <p className="mt-1.5 border-t border-hairline pt-1.5 text-muted-foreground">
        {num.format(count)} sale{count === 1 ? "" : "s"}
      </p>
    </div>
  );
}
