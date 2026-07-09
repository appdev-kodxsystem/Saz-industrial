type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

const map: Record<StockStatus, { label: string; cls: string }> = {
  in_stock: { label: "In Stock", cls: "bg-success text-success-foreground" },
  low_stock: { label: "Low Stock", cls: "bg-warning text-warning-foreground" },
  out_of_stock: { label: "Out of Stock", cls: "bg-danger text-danger-foreground" },
};

export function StockBadge({ status }: { status: StockStatus }) {
  const s = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
