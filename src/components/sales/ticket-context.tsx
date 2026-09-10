"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * The open ticket at the till.
 *
 * This replaced a multi-cart, drawer-based "add to cart" flow. A counter sells
 * to the person standing in front of it: there is ONE ticket, it is always on
 * screen, and clicking an item puts it on the ticket. Nothing to open, nothing
 * to switch between.
 *
 * A ticket is grouped by product (a LINE), with one entry per physical unit
 * underneath it — because `sales` records one row per unit, each carrying the
 * cost of the specific stock item it came from. The line is what you interact
 * with; the units are what get sold.
 */
export interface TicketAddon {
  /** absent for a one-off typed in at the till */
  addonId?: string;
  name: string;
  code: string;
  qty: number;
  unitCost: number;
  listValue: number;
  isCustom: boolean;
}

export interface TicketUnit {
  uid: string;
  stockItemId: string;
  manufactureId: string;
  cost: number;
  /** kept as a string so the field can be emptied while typing */
  price: string;
}

export interface TicketLine {
  productId: string;
  name: string;
  sku: string;
  imageUrl: string | null;
  listPrice: number;
  units: TicketUnit[];
  /** true = each unit carries its own price, edited individually */
  perUnit: boolean;
  /** the price every unit uses while `perUnit` is false */
  price: string;
  /** free extras going out with this item, catalogue or custom */
  addons: TicketAddon[];
}

export interface AvailableUnit {
  id: string;
  manufacture_id: string;
  purchase_price: number;
}

const STORAGE_KEY = "saz_ticket_v1";
const DOCK_KEY = "saz_ticket_dock_open";

function genId() {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `id_${Math.floor(performance.now() * 1000)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const num = (s: string) => Math.max(0, Number(s) || 0);

/** What every unit on a line is priced at, in order. */
export function unitPricesOf(line: TicketLine): number[] {
  return line.units.map((u) => num(line.perUnit ? u.price : line.price));
}

export function lineTotal(line: TicketLine): number {
  return unitPricesOf(line).reduce((a, b) => a + b, 0);
}

export function lineCost(line: TicketLine): number {
  return line.units.reduce((a, u) => a + u.cost, 0);
}

export function lineAddonCost(line: TicketLine): number {
  return line.addons.reduce((a, x) => a + x.unitCost * x.qty, 0);
}

/**
 * Spread a line's add-ons across its units.
 *
 * "Three saws, three carry cases" means one case per saw, so an add-on quantity
 * that divides evenly into the unit count is distributed one-for-one. Anything
 * that does not divide evenly goes onto the first unit rather than being split
 * into a fiction — the sale total is identical either way, and the detail page
 * then shows what actually happened.
 */
export function addonsPerUnit(line: TicketLine): TicketAddon[][] {
  const n = line.units.length;
  const out: TicketAddon[][] = Array.from({ length: n }, () => []);
  if (!n) return out;
  for (const a of line.addons) {
    if (a.qty % n === 0) {
      const each = a.qty / n;
      for (let i = 0; i < n; i++) out[i].push({ ...a, qty: each });
    } else {
      out[0].push({ ...a });
    }
  }
  return out;
}

interface Ticket {
  lines: TicketLine[];
  customerName: string;
  customerContact: string;
  note: string;
  /** what the customer actually handed over; "" means "the full total" */
  paid: string;
}

const EMPTY: Ticket = { lines: [], customerName: "", customerContact: "", note: "", paid: "" };

interface TicketContextValue extends Ticket {
  unitCount: number;
  /** Is the app-wide ticket dock pinned open? Lives here rather than in the
   *  dock so the layout can inset the page by exactly the width it takes. */
  dockOpen: boolean;
  setDockOpen: (v: boolean) => void;
  total: number;
  cost: number;
  addonCost: number;
  /** stock unit ids already on the ticket — they cannot be sold twice */
  claimedUnitIds: Set<string>;
  qtyFor: (productId: string) => number;
  /** Put one more unit of a product on the ticket, drawn from `available`. */
  addUnit: (
    product: {
      id: string;
      name: string;
      sku: string;
      image_url: string | null;
      selling_price: number;
    },
    available: AvailableUnit[],
  ) => boolean;
  removeUnit: (productId: string) => void;
  removeLine: (productId: string) => void;
  patchLine: (productId: string, patch: Partial<TicketLine>) => void;
  setUnitPrice: (productId: string, uid: string, price: string) => void;
  togglePerUnit: (productId: string) => void;
  addAddon: (productId: string, addon: TicketAddon) => void;
  removeAddon: (productId: string, index: number) => void;
  setAddonQty: (productId: string, index: number, qty: number) => void;
  setCustomer: (patch: { name?: string; contact?: string; note?: string }) => void;
  setPaid: (v: string) => void;
  /**
   * A slip or photo to file against this sale, held until checkout uploads it.
   *
   * Deliberately NOT part of `Ticket`: that is persisted to localStorage on
   * every keystroke and a File does not survive JSON. Keeping it beside the
   * ticket rather than inside PosTicket still means the attachment follows the
   * sale between the dock and the Sales page, which is the part that matters —
   * it is simply lost on a reload, unlike the rest of the ticket.
   */
  receipt: File | null;
  setReceipt: (f: File | null) => void;
  clear: () => void;
}

const TicketContext = createContext<TicketContextValue | null>(null);

function loadInitial(): Ticket {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw);
    if (!Array.isArray(p?.lines)) return EMPTY;
    return { ...EMPTY, ...p };
  } catch {
    return EMPTY;
  }
}

/**
 * An unfinished ticket survives a reload — a till that loses the sale in
 * progress because a tab refreshed is worse than useless at a counter.
 */
export function TicketProvider({ children }: { children: React.ReactNode }) {
  const [ticket, setTicket] = useState<Ticket>(loadInitial);
  const [dockOpen, setDockOpenState] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);

  // Restore the dock's pinned state after mount, then keep it written back.
  useEffect(() => {
    try {
      setDockOpenState(window.localStorage.getItem(DOCK_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const setDockOpen = useCallback((v: boolean) => {
    setDockOpenState(v);
    try {
      window.localStorage.setItem(DOCK_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  // A sale in progress opens the dock by itself: something added to the ticket
  // from another page would otherwise land somewhere invisible, which is how a
  // till loses track of what it is holding.
  const hasItems = ticket.lines.length > 0;
  useEffect(() => {
    if (hasItems) setDockOpenState(true);
  }, [hasItems]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ticket));
    } catch {
      /* a full or disabled store must not break the till */
    }
  }, [ticket]);

  const update = useCallback((fn: (t: Ticket) => Ticket) => setTicket((prev) => fn(prev)), []);

  const mapLines = useCallback(
    (productId: string, fn: (l: TicketLine) => TicketLine) =>
      update((t) => ({
        ...t,
        lines: t.lines.map((l) => (l.productId === productId ? fn(l) : l)),
      })),
    [update],
  );

  const value = useMemo<TicketContextValue>(() => {
    const claimedUnitIds = new Set<string>();
    for (const l of ticket.lines) for (const u of l.units) claimedUnitIds.add(u.stockItemId);

    const total = ticket.lines.reduce((n, l) => n + lineTotal(l), 0);
    const cost = ticket.lines.reduce((n, l) => n + lineCost(l), 0);
    const addonCost = ticket.lines.reduce((n, l) => n + lineAddonCost(l), 0);
    const unitCount = ticket.lines.reduce((n, l) => n + l.units.length, 0);

    return {
      ...ticket,
      unitCount,
      dockOpen,
      setDockOpen,
      total,
      cost,
      addonCost,
      claimedUnitIds,
      qtyFor: (productId) => ticket.lines.find((l) => l.productId === productId)?.units.length ?? 0,

      addUnit: (product, available) => {
        // FIFO, skipping anything already on the ticket. Returns false when the
        // shelf is empty so the caller can say so instead of silently no-oping.
        const claimed = new Set<string>();
        for (const l of ticket.lines) for (const u of l.units) claimed.add(u.stockItemId);
        const next = available.find((u) => !claimed.has(u.id));
        if (!next) return false;

        const unit: TicketUnit = {
          uid: genId(),
          stockItemId: next.id,
          manufactureId: next.manufacture_id,
          cost: Number(next.purchase_price) || 0,
          price: "",
        };

        update((t) => {
          const at = t.lines.findIndex((l) => l.productId === product.id);
          if (at === -1) {
            // The catalogue price prefills the line, so "sell one at the usual
            // price" is a single click and no typing.
            const listPrice = Number(product.selling_price) || 0;
            const line: TicketLine = {
              productId: product.id,
              name: product.name,
              sku: product.sku,
              imageUrl: product.image_url,
              listPrice,
              units: [{ ...unit, price: listPrice ? String(listPrice) : "" }],
              perUnit: false,
              price: listPrice ? String(listPrice) : "",
              addons: [],
            };
            return { ...t, lines: [...t.lines, line] };
          }
          return {
            ...t,
            lines: t.lines.map((l, i) =>
              i === at ? { ...l, units: [...l.units, { ...unit, price: l.price }] } : l,
            ),
          };
        });
        return true;
      },

      removeUnit: (productId) =>
        update((t) => ({
          ...t,
          lines: t.lines
            .map((l) => (l.productId === productId ? { ...l, units: l.units.slice(0, -1) } : l))
            // A line with no units is not a line.
            .filter((l) => l.units.length > 0),
        })),

      removeLine: (productId) =>
        update((t) => ({ ...t, lines: t.lines.filter((l) => l.productId !== productId) })),

      patchLine: (productId, patch) => mapLines(productId, (l) => ({ ...l, ...patch })),

      setUnitPrice: (productId, uid, price) =>
        mapLines(productId, (l) => ({
          ...l,
          units: l.units.map((u) => (u.uid === uid ? { ...u, price } : u)),
        })),

      // Switching to per-unit seeds every unit with the shared price already
      // typed, so the toggle is a starting point to edit rather than a reset.
      togglePerUnit: (productId) =>
        mapLines(productId, (l) =>
          l.perUnit
            ? { ...l, perUnit: false, price: l.units[0]?.price || l.price }
            : { ...l, perUnit: true, units: l.units.map((u) => ({ ...u, price: l.price })) },
        ),

      addAddon: (productId, addon) =>
        mapLines(productId, (l) => {
          // Adding the same catalogue add-on again bumps its quantity rather
          // than stacking a second identical row.
          const at = addon.addonId ? l.addons.findIndex((a) => a.addonId === addon.addonId) : -1;
          if (at === -1) return { ...l, addons: [...l.addons, addon] };
          return {
            ...l,
            addons: l.addons.map((a, i) => (i === at ? { ...a, qty: a.qty + addon.qty } : a)),
          };
        }),

      removeAddon: (productId, index) =>
        mapLines(productId, (l) => ({ ...l, addons: l.addons.filter((_, i) => i !== index) })),

      setAddonQty: (productId, index, qty) =>
        mapLines(productId, (l) => ({
          ...l,
          addons:
            qty <= 0
              ? l.addons.filter((_, i) => i !== index)
              : l.addons.map((a, i) => (i === index ? { ...a, qty } : a)),
        })),

      setCustomer: (patch) =>
        update((t) => ({
          ...t,
          customerName: patch.name ?? t.customerName,
          customerContact: patch.contact ?? t.customerContact,
          note: patch.note ?? t.note,
        })),

      setPaid: (v) => update((t) => ({ ...t, paid: v })),

      receipt,
      setReceipt,

      clear: () => {
        setTicket(EMPTY);
        setReceipt(null);
      },
    };
  }, [ticket, update, mapLines, dockOpen, setDockOpen, receipt]);

  return <TicketContext.Provider value={value}>{children}</TicketContext.Provider>;
}

export function useTicket() {
  const ctx = useContext(TicketContext);
  if (!ctx) throw new Error("useTicket must be used within <TicketProvider>");
  return ctx;
}

/**
 * Spread the amount the customer handed over across the ticket's units, filling
 * each up to its price in turn.
 *
 * `sales.net_payment` lives per unit, but a customer pays for the SALE. Which
 * unit a rupee lands on has no accounting meaning; filling in order keeps a
 * part-paid sale readable ("two paid, one outstanding") instead of smearing a
 * fraction across every line. The server settles later payments the same way.
 */
export function distributePayment(prices: number[], paid: number): number[] {
  let left = paid;
  return prices.map((p) => {
    const take = Math.min(left, p);
    left -= take;
    return take;
  });
}
