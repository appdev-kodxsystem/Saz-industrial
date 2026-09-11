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
 * On a wide screen it lays out at its NATURAL width and scrolls sideways inside
 * its card if that is wider than the space it was given. Sales renders this in
 * half a screen beside the till, and forcing seven columns into that space wraps
 * "Sep 11, 2026" down four lines and breaks a figure across two — a table that
 * has to be deciphered is worse than one that has to be scrolled.
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
        <table className="w-max min-w-full text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
              {columns.map((c) => (
                <th
                  key={c.header}
                  className={`whitespace-nowrap px-4 py-3 font-medium ${
                    c.align === "right" ? "text-right" : ""
                  } ${c.className ?? ""}`}
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
                    className={`whitespace-nowrap px-4 py-3 tabular-nums ${
                      c.align === "right" ? "text-right" : ""
                    } ${c.className ?? ""}`}
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

// Re-exported so the ledger pages that already import `money` from here keep
// working, while there is only one implementation of it in the app.
export { moneyExact as money } from "@/lib/money";

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
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface px-4 py-3 ring-1 ring-hairline">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={`text-lg font-semibold tracking-tight tabular-nums ${valueTone}`}>
        {value}
      </span>
    </div>
  );
}

export function KpiRow({ children }: { children: React.ReactNode }) {
  // Tracks come from the row's own width rather than a breakpoint of any kind:
  // these sit in a full-width page on Purchases and in half of one beside the
  // till on Sales, and a fixed column count turns the narrow case into a 2×2 of
  // tall boxes with nothing in them. A figure and its label need about 160px —
  // past that, more tiles fit on the line instead of each one growing taller.
  return (
    <section className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
      {children}
    </section>
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
