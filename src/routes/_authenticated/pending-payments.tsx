import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Phone } from "lucide-react";
import {
  listPendingPayments,
  settlePayment,
  type PendingPaymentRow,
} from "@/lib/inventory.functions";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";
import { SearchBox, Pagination } from "@/components/inventory/TableControls";
import { DateFilter, useDateFilter } from "@/components/inventory/DateFilter";
import {
  DateCell,
  Kpi,
  KpiRow,
  TransactionTable,
  money,
  type TxColumn,
} from "@/components/inventory/TransactionTable";
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

const PAGE_SIZE = 10;

/**
 * What customers still owe, one row per SALE.
 *
 * A balance belongs to the sale, not to each unit on it: someone who took three
 * machines and paid half owes one amount, and used to appear here three times
 * with a third of the balance each. Settling now credits the sale, and the
 * server spreads it across the units underneath.
 */
function PendingPaymentsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useServerFn(listPendingPayments);
  const { period, range, onChange } = useDateFilter("all");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [active, setActive] = useState<PendingPaymentRow | null>(null);

  // debounce the search box so each keystroke doesn't hit the API
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [search, range.from, range.to]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["pending-payments", search, page, range.from, range.to],
    queryFn: () =>
      list({ data: { page, pageSize: PAGE_SIZE, search, from: range.from, to: range.to } }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const columns: TxColumn<PendingPaymentRow>[] = [
    { header: "Date", render: (r) => <DateCell iso={r.created_at} /> },
    {
      header: "Customer / Items",
      render: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.customer_name || "Walk-in"}</span>
          <span className="truncate text-xs text-muted-foreground">{r.item_summary}</span>
          {r.customer_contact && (
            <span className="inline-flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Phone className="size-3" />
              {r.customer_contact}
            </span>
          )}
        </div>
      ),
    },
    {
      header: "Units",
      align: "right",
      render: (r) => <span className="text-muted-foreground">{r.unit_count}</span>,
    },
    { header: "Sale Total", align: "right", render: (r) => money(r.total_amount) },
    {
      header: "Received",
      align: "right",
      render: (r) => <span className="text-muted-foreground">{money(r.net_payment)}</span>,
    },
    {
      header: "Pending",
      align: "right",
      render: (r) => (
        <span className="font-medium text-danger-foreground">{money(r.pending_payment)}</span>
      ),
    },
    {
      header: "Action",
      align: "right",
      render: (r) => (
        <button
          onClick={(e) => {
            // The row itself opens the sale; this button is the other action on
            // it, so it must not also navigate.
            e.stopPropagation();
            setActive(r);
          }}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-95"
        >
          Add Payment
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Pending Payments" subtitle="Sales with an outstanding balance">
        <DateFilter period={period} range={range} onChange={onChange} />
      </PageHeader>

      <PageBody>
        <KpiRow>
          <Kpi label="Pending Sales" value={String(total)} />
          <Kpi label="Outstanding" value={money(data?.outstanding ?? 0)} tone="danger" />
          <Kpi label="Received" value={money(data?.received ?? 0)} tone="good" />
        </KpiRow>

        <div className="mb-4 flex justify-end">
          <SearchBox
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search customer or product…"
          />
        </div>

        {isLoading ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <TransactionTable
            rows={rows}
            columns={columns}
            onOpen={(r) => navigate({ to: "/sales/$saleId", params: { saleId: r.id } })}
            empty={
              <p className="mt-10 text-center text-sm text-muted-foreground">
                {search
                  ? "No results match your search."
                  : "No pending payments. Every sale is settled."}
              </p>
            }
          />
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
          for (const key of [["pending-payments"], ["sales"], ["sale"], ["profit-series"]]) {
            qc.invalidateQueries({ queryKey: key, refetchType: "active" });
          }
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
      const fullyPaid = record ? vars.net_payment >= record.total_amount : false;
      toast.success(fullyPaid ? "Payment completed" : "Payment added");
      onSettled();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to update payment"),
  });

  if (!record) return null;

  const addNum = addPayment === "" ? 0 : Number(addPayment);
  const maxAdd = Math.max(0, record.total_amount - record.net_payment);
  const newNet = record.net_payment + addNum;
  const pendingNum = Math.max(0, record.total_amount - newNet);
  const exceeds = newNet > record.total_amount;

  return (
    <Dialog open={!!record} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Payment</DialogTitle>
          <DialogDescription>
            {record.customer_name || "Walk-in"} · {record.item_summary}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-surface-muted p-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Sale Total</div>
              <div className="font-medium tabular-nums">{money(record.total_amount)}</div>
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
                const n = Number(v);
                setAddPayment(String(Math.max(0, Number.isNaN(n) ? 0 : n)));
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
              className="rounded-lg bg-surface-muted p-2 text-muted-foreground ring-1 ring-hairline"
            />
            <span className="text-xs text-muted-foreground">
              {pendingNum === 0
                ? "This sale will be marked as completed."
                : "Auto-calculated: sale total − total received."}
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
                  ? "cursor-wait bg-primary/70"
                  : exceeds
                    ? "cursor-not-allowed bg-primary/70"
                    : "cursor-pointer bg-primary hover:bg-primary/90"
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
