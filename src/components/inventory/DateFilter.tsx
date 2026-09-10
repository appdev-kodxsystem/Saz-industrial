"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { CalendarDays, Check, X } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";

/**
 * The one date filter every ledger and report uses.
 *
 * Presets cover the common questions ("what happened today", "this month"), and
 * Custom opens a two-ended calendar for everything else. Both produce the same
 * thing: an inclusive `[from, to]` pair in epoch milliseconds, computed HERE, on
 * the client, so that "today" means the user's today and not the server's.
 *
 * `0` on either end means unbounded — which is how "All time" is expressed
 * without a special case travelling through every query.
 */
export type PeriodId = "day" | "week" | "month" | "year" | "all" | "custom";

export interface DateRange {
  from: number;
  to: number;
}

export const ALL_TIME: DateRange = { from: 0, to: 0 };

const PRESETS: { id: PeriodId; label: string }[] = [
  { id: "day", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
  { id: "all", label: "All" },
];

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** Inclusive bounds for a preset, in the viewer's own timezone. */
export function presetRange(period: Exclude<PeriodId, "custom">): DateRange {
  if (period === "all") return ALL_TIME;
  const now = new Date();
  const to = endOfDay(now).getTime();
  const start = startOfDay(now);

  if (period === "day") return { from: start.getTime(), to };
  if (period === "week") {
    const day = (start.getDay() + 6) % 7; // Monday = 0
    start.setDate(start.getDate() - day);
    return { from: start.getTime(), to };
  }
  if (period === "month") {
    return { from: new Date(start.getFullYear(), start.getMonth(), 1).getTime(), to };
  }
  return { from: new Date(start.getFullYear(), 0, 1).getTime(), to };
}

const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function rangeLabel(period: PeriodId, range: DateRange): string {
  if (period !== "custom") return PRESETS.find((p) => p.id === period)?.label ?? "All";
  if (!range.from && !range.to) return "Custom";
  if (range.from && range.to) {
    const sameDay =
      startOfDay(new Date(range.from)).getTime() === startOfDay(new Date(range.to)).getTime();
    return sameDay ? dayLabel(range.from) : `${dayLabel(range.from)} – ${dayLabel(range.to)}`;
  }
  return range.from ? `From ${dayLabel(range.from)}` : `Until ${dayLabel(range.to)}`;
}

export function DateFilter({
  period,
  range,
  onChange,
  className = "",
}: {
  period: PeriodId;
  range: DateRange;
  onChange: (period: PeriodId, range: DateRange) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DayPickerRange | undefined>(undefined);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Seed the calendar from whatever is currently applied, so reopening Custom
  // shows the range you are looking at rather than an empty picker.
  useEffect(() => {
    if (!open) return;
    setDraft(
      range.from || range.to
        ? {
            from: range.from ? new Date(range.from) : undefined,
            to: range.to ? new Date(range.to) : undefined,
          }
        : undefined,
    );
  }, [open, range.from, range.to]);

  // Click-away and Escape both close it. A filter popover that traps you is
  // worse than no popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const customLabel = useMemo(() => rangeLabel("custom", range), [range]);
  const applyDisabled = !draft?.from;

  const apply = () => {
    if (!draft?.from) return;
    // A single tapped day is a one-day range, not an open-ended one.
    onChange("custom", {
      from: startOfDay(draft.from).getTime(),
      to: endOfDay(draft.to ?? draft.from).getTime(),
    });
    setOpen(false);
  };

  return (
    <div className={`-mx-1 flex flex-wrap items-center gap-2 px-1 ${className}`}>
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onChange(p.id, presetRange(p.id as Exclude<PeriodId, "custom">))}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
            period === p.id
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
          }`}
        >
          {p.label}
        </button>
      ))}

      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
            period === "custom"
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-muted-foreground ring-1 ring-hairline hover:bg-secondary"
          }`}
        >
          <CalendarDays className="size-3.5" />
          {period === "custom" ? customLabel : "Custom"}
        </button>

        {period === "custom" && (
          <button
            type="button"
            aria-label="Clear the custom date range"
            onClick={() => onChange("month", presetRange("month"))}
            className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-surface text-muted-foreground ring-1 ring-hairline transition hover:text-foreground"
          >
            <X className="size-2.5" />
          </button>
        )}

        {open && (
          <div className="absolute right-0 z-50 mt-2 w-max rounded-2xl border border-hairline bg-background p-3 shadow-lg">
            <Calendar
              mode="range"
              numberOfMonths={1}
              selected={draft}
              onSelect={setDraft}
              disabled={{ after: new Date() }}
              className="p-0 [--cell-size:2.1rem]"
            />
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-3">
              <span className="text-xs text-muted-foreground">
                {draft?.from
                  ? rangeLabel("custom", {
                      from: startOfDay(draft.from).getTime(),
                      to: endOfDay(draft.to ?? draft.from).getTime(),
                    })
                  : "Pick a start date"}
              </span>
              <button
                type="button"
                onClick={apply}
                disabled={applyDisabled}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition active:scale-95 disabled:opacity-40"
              >
                <Check className="size-3.5" />
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Everything a page needs to drive a <DateFilter>, in one hook. */
export function useDateFilter(initial: PeriodId = "month") {
  const [period, setPeriod] = useState<PeriodId>(initial);
  const [range, setRange] = useState<DateRange>(() =>
    presetRange(initial === "custom" ? "month" : initial),
  );
  const onChange = (p: PeriodId, r: DateRange) => {
    setPeriod(p);
    setRange(r);
  };
  return { period, range, onChange };
}
