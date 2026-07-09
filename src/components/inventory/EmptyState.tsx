import { PackagePlus, SearchX } from "lucide-react";

export function EmptyInventory({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-3xl bg-surface px-8 py-20 text-center ring-1 ring-hairline">
      <div className="relative">
        <div className="absolute -inset-6 rounded-full bg-foreground/5 blur-2xl" />
        <div className="relative grid size-20 place-items-center rounded-2xl bg-surface-muted ring-1 ring-hairline">
          <PackagePlus className="size-9 text-muted-foreground" strokeWidth={1.5} />
        </div>
      </div>
      <div className="flex max-w-sm flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Your inventory is empty</h2>
        <p className="text-sm text-muted-foreground">
          Add your first product to start tracking stock, sales, and profits.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <PackagePlus className="size-4" />
          Add First Product
        </button>
      </div>
    </div>
  );
}

export function NoResults({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-3xl bg-surface px-8 py-16 text-center ring-1 ring-hairline">
      <div className="grid size-14 place-items-center rounded-2xl bg-surface-muted ring-1 ring-hairline">
        <SearchX className="size-6 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="text-base font-semibold">No matching products found</h2>
        <p className="text-sm text-muted-foreground">Try a different search or clear your filters.</p>
      </div>
      <button onClick={onReset} className="rounded-lg bg-secondary px-3 py-2 text-xs font-medium hover:bg-accent">
        Reset filters
      </button>
    </div>
  );
}
