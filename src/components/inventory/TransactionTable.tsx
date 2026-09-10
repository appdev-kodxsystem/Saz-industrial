"use client";

import { relativeTime } from "@/lib/relative-time";

/**
 * The table both ledgers render.
 *
 * Sales and Purchases now list the same SHAPE of thing — one row per
 * transaction, click through for the lines — so they share one table instead of
 * each growing their own. What differs between them is only the columns, which
 * is what the caller supplies.
 *
 * Below `md` the table becomes cards: the first two columns form the card
 * header (they are always [date, subject]) and the rest become label/value
 * rows. A ledger row has six or seven columns, and none of them survive being
 * squeezed to phone width.
 */
export interface TxColumn<T> {
  header: string;
  align?: "left" | "right";
  render: (row: T) => React.ReactNode;
  className?: string;
}

export function TransactionTable<T extends { id: string }>({
  rows,
  columns,
  onOpen,
  empty,
}: {
  rows: T[];
  columns: TxColumn<T>[];
  onOpen?: (row: T) => void;
  empty: React.ReactNode;
}) {
  if (!rows.length) return <>{empty}</>;

  const [headCol, subjectCol, ...rest] = columns;

  return (
    <>
      <div className="hidden overflow-x-auto rounded-2xl bg-surface ring-1 ring-hairline md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
              {columns.map((c) => (
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
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={onOpen ? () => onOpen(r) : undefined}
                className={`border-b border-hairline last:border-0 transition hover:bg-surface-muted ${
                  onOpen ? "cursor-pointer" : ""
                }`}
              >
                {columns.map((c) => (
                  <td
                    key={c.header}
                    className={`px-4 py-3 tabular-nums ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((r) => (
          <div
            key={r.id}
            onClick={onOpen ? () => onOpen(r) : undefined}
            className={`rounded-2xl bg-surface p-4 ring-1 ring-hairline ${
              onOpen ? "cursor-pointer active:bg-surface-muted" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-hairline pb-3">
              <div className="min-w-0">{subjectCol.render(r)}</div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                {headCol.render(r)}
              </div>
            </div>
            <dl className="mt-3 flex flex-col gap-2">
              {rest.map((c) => (
                <div key={c.header} className="flex items-center justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">{c.header}</dt>
                  <dd className="text-sm tabular-nums">{c.render(r)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 2,
});

export function money(n: number) {
  return fmt.format(n || 0);
}

export function DateCell({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <div className="flex flex-col">
      <span>
        {d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </span>
      <span className="text-xs text-muted-foreground">{relativeTime(iso)}</span>
    </div>
  );
}

export function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "danger" | "warning";
}) {
  const valueTone =
    tone === "good"
      ? "text-success-foreground"
      : tone === "danger"
        ? "text-danger-foreground"
        : tone === "warning"
          ? "text-warning-foreground"
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

export function KpiRow({ children }: { children: React.ReactNode }) {
  // Container query, not `lg:`. The ticket dock takes 380px off the content
  // column when it opens, and a viewport breakpoint cannot see that — so at
  // `lg:grid-cols-4` the tiles stayed four-across and squeezed, wrapping their
  // own labels and truncating values. Measuring the actual column instead lets
  // them drop a column and keep their size.
  return (
    <div className="@container mb-8">
      <section className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @4xl:grid-cols-4 sm:gap-4">
        {children}
      </section>
    </div>
  );
}

/** Small pill used for payment / stock status across both ledgers. */
export function StatusPill({
  tone,
  children,
}: {
  tone: "good" | "warning" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "good"
      ? "text-success-foreground"
      : tone === "warning"
        ? "text-warning-foreground"
        : "text-muted-foreground";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-hairline ${cls}`}
    >
      {children}
    </span>
  );
}
