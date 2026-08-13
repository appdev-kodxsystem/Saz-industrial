import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileDown, Loader2 } from "lucide-react";
// jspdf + jspdf-autotable are ~400KB of JavaScript that is only ever needed
// once someone actually clicks Export. Imported statically they were part of the
// Reports page bundle, so every visit to Reports downloaded and parsed a PDF
// engine before the page could render. They are imported dynamically inside
// downloadPdf() instead — see below.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { getLedger, type LedgerEntry } from "@/lib/inventory.functions";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "PKR", maximumFractionDigits: 2 });

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function fmtRange(d: Date) {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Brand palette (matches the app's dark neutral primary).
const INK: [number, number, number] = [26, 26, 26];
const MUTED: [number, number, number] = [120, 120, 120];
const POS: [number, number, number] = [22, 101, 52];
const NEG: [number, number, number] = [185, 28, 28];
const LINE: [number, number, number] = [225, 225, 225];

// Loads /logo.png as a PNG data URL for embedding in the PDF.
async function loadLogo(): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = new Image();
    img.src = "/logo.png";
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { data: canvas.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return null;
  }
}

// Generates and downloads a branded PDF report for the selected period.
async function downloadPdf(entries: LedgerEntry[], from: Date, to: Date) {
  // Pulled in on demand; the click that gets here is already an explicit,
  // clearly-async action, so the extra fetch is invisible next to generating the
  // document itself.
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const fromMs = startOfDay(from);
  const toMs = endOfDay(to);
  const inRange = entries.filter((e) => {
    const t = new Date(e.date).getTime();
    return !isNaN(t) && t >= fromMs && t <= toMs;
  });
  const sales = inRange.filter((e) => e.kind === "sale").sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const purchases = inRange
    .filter((e) => e.kind === "purchase")
    .sort((a, b) => +new Date(a.date) - +new Date(b.date));

  const revenue = sales.reduce((a, e) => a + e.amount, 0);
  const cogs = sales.reduce((a, e) => a + e.cost, 0);
  const profit = sales.reduce((a, e) => a + e.profit, 0);
  const spend = purchases.reduce((a, e) => a + e.amount, 0);
  const inStock = purchases.filter((e) => !e.sold).length;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 40;
  const contentW = pageW - M * 2;

  // --- Header: logo + title ---
  const logo = await loadLogo();
  let titleX = M;
  if (logo) {
    const h = 34;
    const w = (logo.w / logo.h) * h;
    doc.addImage(logo.data, "PNG", M, M, w, h);
    titleX = M + w + 12;
  } else {
    doc.setFillColor(...INK);
    doc.roundedRect(M, M, 30, 30, 6, 6, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("S", M + 15, M + 21, { align: "center" });
    titleX = M + 42;
  }

  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("SAZ Industrial — Inventory Report", titleX, M + 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(
    `Period: ${fmtRange(from)} – ${fmtRange(to)}   ·   Generated ${new Date().toLocaleString("en-US")}`,
    titleX,
    M + 28,
  );

  // --- KPI cards (two rows of four) ---
  const cards: { label: string; value: string }[] = [
    { label: "Revenue", value: money.format(revenue) },
    { label: "Profit", value: money.format(profit) },
    { label: "Margin", value: `${margin.toFixed(1)}%` },
    { label: "Purchase Spend", value: money.format(spend) },
    { label: "Units Sold", value: String(sales.length) },
    { label: "Cost of Goods Sold", value: money.format(cogs) },
    { label: "Units Purchased", value: String(purchases.length) },
    { label: "Still In Stock", value: String(inStock) },
  ];
  const gap = 10;
  const cardW = (contentW - gap * 3) / 4;
  const cardH = 42;
  let cy = M + 50;
  cards.forEach((c, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = M + col * (cardW + gap);
    const y = cy + row * (cardH + gap);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.8);
    doc.roundedRect(x, y, cardW, cardH, 5, 5, "S");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(c.label.toUpperCase(), x + 8, y + 15);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text(c.value, x + 8, y + 33);
  });
  cy += cardH * 2 + gap + 20;

  // --- Section heading helper ---
  const heading = (title: string, y: number) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    doc.text(title, M, y);
    doc.setDrawColor(...INK);
    doc.setLineWidth(1.2);
    doc.line(M, y + 4, pageW - M, y + 4);
    return y + 14;
  };

  // --- Sales table ---
  let yStart = heading(`Sales (${sales.length})`, cy);
  autoTable(doc, {
    startY: yStart,
    margin: { left: M, right: M },
    head: [["Date", "Product", "SKU", "Sale Price", "Cost", "Profit"]],
    body: sales.length
      ? sales.map((e) => [
          fmtDate(e.date),
          e.product_name,
          e.sku,
          money.format(e.amount),
          money.format(e.cost),
          money.format(e.profit),
        ])
      : [["—", "No sales in this period", "", "", "", ""]],
    foot: sales.length
      ? [["", "Totals", "", money.format(revenue), money.format(cogs), money.format(profit)]]
      : undefined,
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: INK, textColor: 255, fontSize: 8 },
    footStyles: { fillColor: [245, 245, 245], textColor: INK, fontStyle: "bold" },
    columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 5 && sales.length) {
        const v = sales[data.row.index]?.profit ?? 0;
        data.cell.styles.textColor = v >= 0 ? POS : NEG;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  // --- Purchases table ---
  const afterSales = (doc as any).lastAutoTable.finalY + 24;
  yStart = heading(`Purchases / Stock In (${purchases.length})`, afterSales);
  autoTable(doc, {
    startY: yStart,
    margin: { left: M, right: M },
    head: [["Date", "Product", "SKU", "Batch / Mfr ID", "Purchase Price", "Status"]],
    body: purchases.length
      ? purchases.map((e) => [
          fmtDate(e.date),
          e.product_name,
          e.sku,
          e.reference,
          money.format(e.amount),
          e.sold ? "Sold" : "In stock",
        ])
      : [["—", "No purchases in this period", "", "", "", ""]],
    foot: purchases.length ? [["", "Total Spend", "", "", money.format(spend), ""]] : undefined,
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: INK, textColor: 255, fontSize: 8 },
    footStyles: { fillColor: [245, 245, 245], textColor: INK, fontStyle: "bold" },
    columnStyles: { 4: { halign: "right" } },
  });

  // --- Footer page numbers ---
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`SAZ Industrial · Page ${i} of ${pages}`, pageW / 2, doc.internal.pageSize.getHeight() - 20, {
      align: "center",
    });
  }

  const fname = `vault-report_${fmtRange(from)}_to_${fmtRange(to)}`.replace(/[^\w-]+/g, "-");
  doc.save(`${fname}.pdf`);
}

export function PrintReportDialog() {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>();
  const ledger = useServerFn(getLedger);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["ledger"],
    queryFn: () => ledger(),
    enabled: open,
  });

  const count = useMemo(() => {
    if (!range?.from || !range?.to) return null;
    const fromMs = startOfDay(range.from);
    const toMs = endOfDay(range.to);
    return entries.filter((e) => {
      const t = new Date(e.date).getTime();
      return !isNaN(t) && t >= fromMs && t <= toMs;
    }).length;
  }, [entries, range]);

  const [exporting, setExporting] = useState(false);
  const canExport = Boolean(range?.from && range?.to);

  async function handleExport() {
    if (!range?.from || !range?.to) return;
    setExporting(true);
    try {
      await downloadPdf(entries, range.from, range.to);
      setOpen(false);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-sm font-medium ring-1 ring-hairline transition hover:bg-accent active:scale-95">
          <FileDown className="size-4" />
          <span className="hidden sm:inline">Export PDF</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100vw-2rem)] p-4 sm:max-w-fit sm:p-6 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Export PDF report</DialogTitle>
          <DialogDescription>
            Select a date range. The PDF includes all sales and purchases in that period.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center">
          <Calendar
            mode="range"
            numberOfMonths={1}
            selected={range}
            onSelect={setRange}
            disabled={{ after: new Date() }}
            className="rounded-xl ring-1 ring-hairline p-3 [--cell-size:2.5rem] sm:p-4 sm:[--cell-size:2.2rem]"
          />
        </div>

        <div className="min-h-5 text-center text-xs text-muted-foreground">
          {isLoading
            ? "Loading records…"
            : range?.from && range?.to
              ? `${fmtRange(range.from)} – ${fmtRange(range.to)} · ${count} record${count === 1 ? "" : "s"}`
              : "Pick a start and end date"}
        </div>

        <DialogFooter>
          <button
            onClick={handleExport}
            disabled={!canExport || isLoading}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
            Download PDF
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
