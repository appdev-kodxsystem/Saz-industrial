"use client";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { money } from "@/lib/money";

/**
 * How much of the bill was settled.
 *
 * There is no change to give: machinery is paid by an agreed amount — in full,
 * as a deposit, or on account — not with a note handed across a counter. So the
 * only question here is how much of the bill has been paid, and the only two
 * numbers that matter are that amount and what is left owing.
 *
 * Whatever is short of the bill is recorded as a balance against the sale — the
 * same `sales.net_payment` the Pending Payments page reads — so "paid in full",
 * "part paid" and "taken on account" are one flow rather than three. More than
 * the bill is not a payment, so the entry stops at the total.
 *
 * The amount is typed straight into the figure it changes, with the three
 * shares anyone actually uses — all, half, none — one tap away beside it.
 */
export function TenderPad({
  total,
  busy,
  onCancel,
  onConfirm,
}: {
  total: number;
  busy?: boolean;
  onCancel: () => void;
  /** The amount actually settled — never more than the bill. What is left over
   *  becomes the balance owed on the sale. */
  onConfirm: (paid: number) => void;
}) {
  // Kept as a string, because "" has to stay distinct from 0: an untouched
  // field means the bill was paid in full, not that nothing was paid.
  const [entry, setEntry] = useState("");
  const typed = entry === "" ? total : Number(entry) || 0;
  // Nothing above the bill is a payment. It is flagged rather than silently
  // rewritten, so a mistyped extra digit is visible before it is recorded.
  const over = typed > total;
  const paid = Math.min(typed, total);
  const balance = total - paid;

  // A deposit against a machine is usually a round share of the bill, not a
  // banknote — so the shortcuts are shares.
  const half = Math.round(total / 2);

  // Digits and at most one decimal point. Anything else pasted or typed is
  // dropped rather than quietly becoming NaN and recording a payment of zero.
  const type = (raw: string) => {
    const cleaned = raw.replace(/[^\d.]/g, "");
    const [whole, ...rest] = cleaned.split(".");
    setEntry(rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole);
  };

  // Escape backs out from anywhere on the pad; Enter is handled on the field
  // itself so it cannot fire while the confirm button has focus twice over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
        <p className="flex-1 text-sm font-semibold">Take payment</p>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Back to the ticket"
          className="grid size-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {/* Owed, received, still owing — largest first. */}
        <div className="rounded-2xl bg-surface-muted p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Total amount
            </span>
            <span className="text-3xl font-semibold tracking-tight tabular-nums">
              {money(total)}
            </span>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-3">
            <label
              htmlFor="tender-received"
              className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              Amount received
            </label>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-sm font-medium text-muted-foreground">PKR</span>
              <input
                id="tender-received"
                autoFocus
                inputMode="decimal"
                value={entry}
                onChange={(e) => type(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (!busy) onConfirm(paid);
                }}
                placeholder={String(Math.round(total))}
                aria-label="Amount received"
                className={`h-11 w-40 rounded-xl bg-surface px-3 text-right text-2xl font-semibold tabular-nums outline-none ring-1 transition focus:ring-2 ${
                  over
                    ? "text-danger-foreground ring-danger/50 focus:ring-danger/50"
                    : "ring-hairline focus:ring-primary/40"
                }`}
              />
            </div>
          </div>

          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-hairline pt-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Amount due
            </span>
            <span
              className={`text-2xl font-semibold tabular-nums ${
                balance > 0 ? "text-warning-foreground" : "text-muted-foreground"
              }`}
            >
              {money(balance)}
            </span>
          </div>
          {over ? (
            <p className="mt-2 text-[11px] font-medium text-danger-foreground">
              More than the bill — {money(total)} will be recorded.
            </p>
          ) : (
            balance > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Recorded against this sale and collected from Pending Payments.
              </p>
            )
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <QuickAmount label="Paid in full" active={entry === ""} onClick={() => setEntry("")} />
          {half > 0 && (
            <QuickAmount
              label={`Half · ${money(half)}`}
              active={entry === String(half)}
              onClick={() => setEntry(String(half))}
            />
          )}
          <QuickAmount label="Unpaid" active={entry === "0"} onClick={() => setEntry("0")} />
        </div>
      </div>

      <footer className="shrink-0 border-t border-hairline p-3.5">
        <button
          type="button"
          onClick={() => onConfirm(paid)}
          disabled={busy}
          className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground transition active:scale-[0.99] disabled:opacity-40"
        >
          <Check className="size-5" />
          {busy
            ? "Recording…"
            : balance > 0
              ? `Record — ${money(balance)} due`
              : `Record — paid in full`}
        </button>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          <kbd className="rounded bg-surface-muted px-1 font-sans ring-1 ring-hairline">Enter</kbd>{" "}
          to confirm ·{" "}
          <kbd className="rounded bg-surface-muted px-1 font-sans ring-1 ring-hairline">Esc</kbd> to
          go back
        </p>
      </footer>
    </div>
  );
}

function QuickAmount({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-10 flex-1 whitespace-nowrap rounded-xl px-3 text-sm font-medium tabular-nums transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-surface-muted text-foreground ring-1 ring-hairline hover:bg-secondary"
      }`}
    >
      {label}
    </button>
  );
}
