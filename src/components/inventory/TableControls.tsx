import { Search, X, ChevronLeft, ChevronRight } from "lucide-react";

// Debounced-friendly search box. Caller owns the value + debouncing; this is just
// the input with a clear button.
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg bg-surface py-2 pl-9 pr-9 text-sm ring-1 ring-hairline outline-none transition focus:ring-2 focus:ring-primary"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

// Server-side pagination control. Shows "X–Y of Z" plus prev/next + page numbers.
// Renders nothing when everything fits on one page.
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  busy = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  busy?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // window of page numbers around the current page (max 5)
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const end = Math.min(pageCount, start + 4);
  const nums: number[] = [];
  for (let i = start; i <= end; i++) nums.push(i);

  return (
    <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
      <span className="text-xs text-muted-foreground tabular-nums">
        Showing {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1 || busy}
          aria-label="Previous page"
          className="grid size-8 place-items-center rounded-lg ring-1 ring-hairline transition hover:bg-secondary disabled:opacity-40"
        >
          <ChevronLeft className="size-4" />
        </button>
        {nums.map((n) => (
          <button
            key={n}
            onClick={() => onPage(n)}
            disabled={busy}
            aria-current={n === page ? "page" : undefined}
            className={`min-w-8 rounded-lg px-2 py-1.5 text-xs font-medium tabular-nums transition ${
              n === page
                ? "bg-primary text-primary-foreground"
                : "ring-1 ring-hairline hover:bg-secondary"
            }`}
          >
            {n}
          </button>
        ))}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount || busy}
          aria-label="Next page"
          className="grid size-8 place-items-center rounded-lg ring-1 ring-hairline transition hover:bg-secondary disabled:opacity-40"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
