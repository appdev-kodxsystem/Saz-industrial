import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ImageOff } from "lucide-react";
import {
  listPendingPayments,
  settlePayment,
  type PendingPaymentRow,
} from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { SearchBox, Pagination } from "@/components/inventory/TableControls";

const PAGE_SIZE = 10;
import { supabaseThumb } from "@/lib/img";
import { relativeTime } from "@/lib/relative-time";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/pending-payments")({
  head: () => ({ meta: [{ title: "Pending Payments — SAZ Industrial" }] }),
  component: PendingPaymentsPage,
});

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 2,
});
const money = (n: number) => fmt.format(n || 0);

function ProductThumb({ url, name }: { url: string | null; name: string }) {
  if (!url) {
    return (
      <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        <ImageOff className="size-5" />
      </div>
    );
  }
  return (
    <img
      src={supabaseThumb(url, 96)}
      alt={name}
      width={48}
      height={48}
      className="size-12 shrink-0 rounded-lg object-cover ring-1 ring-hairline"
      onError={(e) => {
        const img = e.currentTarget;
        if (img.src !== url) img.src = url;
      }}
    />
  );
}

function PendingPaymentsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listPendingPayments);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // debounce the search box so each keystroke doesn't hit the API
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // search change resets to the first page
  useEffect(() => {
    setPage(1);
  }, [search]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["pending-payments", search, page],
    queryFn: () => list({ data: { page, pageSize: PAGE_SIZE, search } }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const kpis = {
    count: total,
    outstanding: data?.outstanding ?? 0,
    received: data?.received ?? 0,
  };

  const [active, setActive] = useState<PendingPaymentRow | null>(null);

  return (
    <>
      <PageHeader
        title="Pending Payments"
        subtitle="Sold items with an outstanding balance"
      />

      <PageBody>
        <section className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          <Kpi label="Pending Records" value={String(kpis.count)} />
          <Kpi label="Outstanding" value={money(kpis.outstanding)} tone="danger" />
          <Kpi label="Received" value={money(kpis.received)} tone="good" />
        </section>

        <div className="mb-4 flex justify-end">
          <SearchBox
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search by product, SKU, or customer…"
          />
        </div>

        {isLoading ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">
            {search
              ? "No results match your search."
              : "No pending payments. All sales are fully settled."}
          </p>
        ) : (
          <>
            {/* Table — md and up */}
            <div className="hidden overflow-x-auto rounded-2xl bg-surface ring-1 ring-hairline md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-4 py-3 font-medium">Sale Date</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 text-right font-medium">Selling Price</th>
                    <th className="px-4 py-3 text-right font-medium">Net Received</th>
                    <th className="px-4 py-3 text-right font-medium">Pending</th>
                    <th className="px-4 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-hairline last:border-0 hover:bg-surface-muted"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <ProductThumb url={r.image_url} name={r.product_name} />
                          <div className="flex min-w-0 flex-col">
                            <span className="font-medium">{r.product_name}</span>
                            <span className="text-xs text-muted-foreground">{r.sku}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span>{new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                          <span className="text-xs text-muted-foreground">{relativeTime(r.created_at)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {r.customer_name || r.customer_contact ? (
                          <div className="flex flex-col">
                            {r.customer_name && <span>{r.customer_name}</span>}
                            {r.customer_contact && (
                              <span className="text-xs text-muted-foreground">{r.customer_contact}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(r.selling_price)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(r.net_payment)}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums text-danger-foreground">
                        {money(r.pending_payment)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setActive(r)}
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-95"
                        >
                          Add Payment
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards — below md */}
            <div className="flex flex-col gap-3 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="rounded-2xl bg-surface p-4 ring-1 ring-hairline">
                  <div className="flex items-start gap-3 border-b border-hairline pb-3">
                    <ProductThumb url={r.image_url} name={r.product_name} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{r.product_name}</span>
                      <span className="text-xs text-muted-foreground">{r.sku}</span>
                    </div>
                    <span className="shrink-0 text-right text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <dl className="mt-3 flex flex-col gap-2">
                    {(r.customer_name || r.customer_contact) && (
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-muted-foreground">Customer</dt>
                        <dd className="text-sm">
                          {r.customer_name}
                          {r.customer_name && r.customer_contact ? " · " : ""}
                          {r.customer_contact}
                        </dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">Selling Price</dt>
                      <dd className="text-sm tabular-nums">{money(r.selling_price)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">Net Received</dt>
                      <dd className="text-sm tabular-nums">{money(r.net_payment)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">Pending</dt>
                      <dd className="text-sm font-medium tabular-nums text-danger-foreground">
                        {money(r.pending_payment)}
                      </dd>
                    </div>
                  </dl>
                  <button
                    onClick={() => setActive(r)}
                    className="mt-3 w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-95"
                  >
                    Add Payment
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {!isLoading && total > 0 && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPage={setPage}
            busy={isFetching}
          />
        )}
      </PageBody>

      <SettleDialog
        record={active}
        onOpenChange={(v) => !v && setActive(null)}
        onSettled={() => {
          setActive(null);
          qc.invalidateQueries({ queryKey: ["pending-payments"], refetchType: "active" });
          qc.invalidateQueries({ queryKey: ["ledger"], refetchType: "active" });
        }}
      />
    </>
  );
}

function SettleDialog({
  record,
  onOpenChange,
  onSettled,
}: {
  record: PendingPaymentRow | null;
  onOpenChange: (v: boolean) => void;
  onSettled: () => void;
}) {
  const settle = useServerFn(settlePayment);
  const [addPayment, setAddPayment] = useState<string>("");

  // reset the add-payment input whenever a record opens
  useEffect(() => {
    if (record) setAddPayment("");
  }, [record]);

  const mut = useMutation({
    mutationFn: (v: { saleId: string; net_payment: number }) => settle({ data: v }),
    onSuccess: (_res, vars) => {
      const fullyPaid = record ? vars.net_payment >= record.selling_price : false;
      toast.success(fullyPaid ? "Payment completed" : "Payment added");
      onSettled();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to update payment"),
  });

  if (!record) return null;

  const addNum = addPayment === "" ? 0 : Number(addPayment);
  const maxAdd = Math.max(0, record.selling_price - record.net_payment);
  const newNet = record.net_payment + addNum;
  const pendingNum = Math.max(0, record.selling_price - newNet);
  const exceeds = newNet > record.selling_price;

  return (
    <Dialog open={!!record} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Payment</DialogTitle>
          <DialogDescription>
            {record.product_name} · {record.sku}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-surface-muted p-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Selling Price</div>
              <div className="font-medium tabular-nums">{money(record.selling_price)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Currently Received</div>
              <div className="font-medium tabular-nums">{money(record.net_payment)}</div>
            </div>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Add payment</span>
            <input
              type="number"
              min={0}
              max={maxAdd}
              value={addPayment}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") return setAddPayment("");
                const num = Number(v);
                setAddPayment(String(Math.max(0, Number.isNaN(num) ? 0 : num)));
              }}
              className="rounded-lg p-2 ring-1 ring-hairline"
            />
            {exceeds ? (
              <span className="text-xs text-danger-foreground">
                Added payment cannot exceed the pending balance ({money(maxAdd)}).
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                New total received: {money(newNet)}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Pending payment remaining</span>
            <input
              type="number"
              value={pendingNum}
              readOnly
              tabIndex={-1}
              aria-readonly="true"
              className="rounded-lg bg-surface-muted p-2 ring-1 ring-hairline text-muted-foreground"
            />
            <span className="text-xs text-muted-foreground">
              {pendingNum === 0
                ? "This payment will be marked as completed."
                : "Auto-calculated: selling price − total received."}
            </span>
          </label>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => onOpenChange(false)}
              disabled={mut.isPending}
              className="flex-1 rounded-xl bg-secondary py-3 text-sm transition hover:bg-accent disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              onClick={() => mut.mutate({ saleId: record.id, net_payment: newNet })}
              disabled={mut.isPending || exceeds || addNum <= 0}
              className={`flex-1 rounded-xl py-3 text-sm text-primary-foreground transition ${
                mut.isPending
                  ? "bg-primary/70 cursor-wait"
                  : exceeds
                    ? "bg-primary/70 cursor-not-allowed"
                    : "bg-primary cursor-pointer hover:bg-primary/90"
              }`}
            >
              {mut.isPending ? "Saving…" : pendingNum === 0 ? "Mark Completed" : "Add Payment"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "danger";
}) {
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
      <span className={`text-xl font-semibold tracking-tight sm:text-2xl tabular-nums ${valueTone}`}>
        {value}
      </span>
    </div>
  );
}
