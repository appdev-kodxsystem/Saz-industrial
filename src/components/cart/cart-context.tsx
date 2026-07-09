"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

// Multiple carts, one per customer. A cart only ever exists with a customer on it
// (no unnamed/placeholder carts) — it's created when a product is committed from
// the entry drawer. A stock unit sitting in ANY cart is "reserved": hidden from
// other carts, subtracted from available stock, and returned the moment it leaves.

export interface CartUnit {
  uid: string;
  productId: string;
  stockItemId: string;
  manufactureId: string;
  cost: number;
  sellingPrice: number;
  netPayment: number;
}

export interface ProductSnapshot {
  productId: string;
  name: string;
  sku: string;
  imageUrl: string | null;
  purchasePrice: number;
  availableStock: number;
}

export interface EntryProduct {
  id: string;
  name: string;
  sku: string;
  image_url: string | null;
  purchase_price: number;
  selling_price: number;
  stock: number;
}

export type EntryLine = Pick<CartUnit, "stockItemId" | "manufactureId" | "cost" | "sellingPrice" | "netPayment">;

interface Cart {
  id: string;
  customerName: string;
  customerContact: string;
  units: CartUnit[];
  snapshots: Record<string, ProductSnapshot>;
}

export interface CartSummary {
  id: string;
  customerName: string;
  customerContact: string;
  count: number;
}

interface CartContextValue {
  // active cart view (empty if no cart selected)
  units: CartUnit[];
  snapshots: Record<string, ProductSnapshot>;
  customerName: string;
  customerContact: string;
  count: number;
  productIds: string[];
  unitsFor: (productId: string) => CartUnit[];
  // multi-cart
  carts: CartSummary[];
  activeCartId: string | null;
  totalUnits: number;
  switchCart: (id: string) => void;
  deleteCart: (id: string) => void;
  unitsForInCart: (cartId: string | null, productId: string) => CartUnit[];
  // reservation
  reservedQty: (productId: string) => number;
  reservedUnitIds: (productId: string, exceptCartId?: string | null) => Set<string>;
  // drawer state
  isOpen: boolean;
  setOpen: (v: boolean) => void;
  entryProduct: EntryProduct | null;
  entryMode: "add" | "edit";
  openEntry: (product: EntryProduct, fromCart?: boolean) => void;
  closeEntry: () => void;
  // commit a product into a target cart (null = create new customer cart). Returns cart id.
  commitEntry: (
    targetCartId: string | null,
    customer: { name: string; contact: string },
    snapshot: ProductSnapshot,
    lines: EntryLine[],
  ) => string;
  // active-cart mutations
  removeProduct: (productId: string) => void;
  setCustomer: (patch: { name?: string; contact?: string }) => void;
  clear: () => void;
  completeActiveCart: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = "saz_carts_v2";

function genId() {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `id_${Math.floor(performance.now() * 1000)}`;
}

interface Persisted {
  carts: Cart[];
  activeCartId: string | null;
}

function loadInitial(): Persisted {
  const fallback: Persisted = { carts: [], activeCartId: null };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    const carts: Cart[] = Array.isArray(p.carts) ? p.carts : [];
    const activeCartId = carts.some((c) => c.id === p.activeCartId) ? p.activeCartId : carts[0]?.id ?? null;
    return { carts, activeCartId };
  } catch {
    return fallback;
  }
}

// Replace one product's units in a cart and stamp the customer.
function applyProduct(
  c: Cart,
  customer: { name: string; contact: string },
  snapshot: ProductSnapshot,
  lines: EntryLine[],
): Cart {
  const others = c.units.filter((u) => u.productId !== snapshot.productId);
  if (lines.length === 0) {
    const { [snapshot.productId]: _d, ...rest } = c.snapshots;
    return { ...c, customerName: customer.name, customerContact: customer.contact, units: others, snapshots: rest };
  }
  const mine: CartUnit[] = lines.map((l) => ({ uid: genId(), productId: snapshot.productId, ...l }));
  return {
    ...c,
    customerName: customer.name,
    customerContact: customer.contact,
    units: [...others, ...mine],
    snapshots: { ...c.snapshots, [snapshot.productId]: snapshot },
  };
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const init = loadInitial();
  const [carts, setCarts] = useState<Cart[]>(init.carts);
  const [activeCartId, setActiveCartId] = useState<string | null>(init.activeCartId);
  const [isOpen, setOpen] = useState(false);
  const [entryProduct, setEntryProduct] = useState<EntryProduct | null>(null);
  const [entryReturnToCart, setEntryReturnToCart] = useState(false);
  const [entryMode, setEntryMode] = useState<"add" | "edit">("add");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ carts, activeCartId }));
    } catch {
      /* ignore */
    }
  }, [carts, activeCartId]);

  const value = useMemo<CartContextValue>(() => {
    const active = carts.find((c) => c.id === activeCartId) ?? null;
    const updateActive = (fn: (c: Cart) => Cart) => {
      if (!active) return;
      setCarts((prev) => prev.map((c) => (c.id === active.id ? fn(c) : c)));
    };

    const unitsFor = (productId: string) => (active ? active.units.filter((u) => u.productId === productId) : []);
    const productIds = (active?.units ?? []).reduce<string[]>((acc, u) => {
      if (!acc.includes(u.productId)) acc.push(u.productId);
      return acc;
    }, []);

    return {
      units: active?.units ?? [],
      snapshots: active?.snapshots ?? {},
      customerName: active?.customerName ?? "",
      customerContact: active?.customerContact ?? "",
      count: active?.units.length ?? 0,
      productIds,
      unitsFor,

      carts: carts.map((c) => ({
        id: c.id,
        customerName: c.customerName,
        customerContact: c.customerContact,
        count: c.units.length,
      })),
      activeCartId: active?.id ?? null,
      totalUnits: carts.reduce((n, c) => n + c.units.length, 0),
      switchCart: (id) => {
        if (carts.some((c) => c.id === id)) {
          setActiveCartId(id);
          setOpen(true);
        }
      },
      deleteCart: (id) =>
        setCarts((prev) => {
          const next = prev.filter((c) => c.id !== id);
          if (id === activeCartId) setActiveCartId(next[0]?.id ?? null);
          return next;
        }),
      unitsForInCart: (cartId, productId) => {
        if (!cartId) return [];
        const c = carts.find((x) => x.id === cartId);
        return c ? c.units.filter((u) => u.productId === productId) : [];
      },

      reservedQty: (productId) =>
        carts.reduce((n, c) => n + c.units.filter((u) => u.productId === productId).length, 0),
      reservedUnitIds: (productId, exceptCartId) => {
        const set = new Set<string>();
        for (const c of carts) {
          if (exceptCartId && c.id === exceptCartId) continue;
          for (const u of c.units) if (u.productId === productId && u.stockItemId) set.add(u.stockItemId);
        }
        return set;
      },

      isOpen,
      setOpen,
      entryProduct,
      entryMode,
      openEntry: (product, fromCart = false) => {
        setEntryProduct(product);
        setEntryReturnToCart(fromCart);
        setEntryMode(fromCart ? "edit" : "add");
        if (fromCart) setOpen(false);
      },
      closeEntry: () => {
        setEntryProduct(null);
        if (entryReturnToCart) setOpen(true);
        setEntryReturnToCart(false);
      },

      commitEntry: (targetCartId, customer, snapshot, lines) => {
        const id = targetCartId ?? genId();
        setCarts((prev) => {
          if (prev.some((c) => c.id === id)) {
            return prev.map((c) => (c.id === id ? applyProduct(c, customer, snapshot, lines) : c));
          }
          const nc: Cart = { id, customerName: "", customerContact: "", units: [], snapshots: {} };
          return [...prev, applyProduct(nc, customer, snapshot, lines)];
        });
        setActiveCartId(id);
        return id;
      },

      removeProduct: (productId) =>
        updateActive((c) => {
          const { [productId]: _d, ...rest } = c.snapshots;
          return { ...c, units: c.units.filter((u) => u.productId !== productId), snapshots: rest };
        }),
      setCustomer: (patch) =>
        updateActive((c) => ({
          ...c,
          customerName: patch.name !== undefined ? patch.name : c.customerName,
          customerContact: patch.contact !== undefined ? patch.contact : c.customerContact,
        })),
      // "Clear" drops the whole cart — keeping an empty cart would be an unnamed shell
      clear: () =>
        setCarts((prev) => {
          if (!active) return prev;
          const next = prev.filter((c) => c.id !== active.id);
          setActiveCartId(next[0]?.id ?? null);
          return next;
        }),
      completeActiveCart: () =>
        setCarts((prev) => {
          if (!active) return prev;
          const next = prev.filter((c) => c.id !== active.id);
          setActiveCartId(next[0]?.id ?? null);
          return next;
        }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carts, activeCartId, isOpen, entryProduct, entryReturnToCart, entryMode]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within <CartProvider>");
  return ctx;
}
