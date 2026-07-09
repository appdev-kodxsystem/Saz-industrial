"use client";

import { ShoppingCart, ChevronDown, Trash2, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useCart } from "./cart-context";

// Cart trigger for the top nav. Opens the active customer's cart. When more than
// one customer cart exists, a chevron dropdown lets you switch / delete carts.
export function CartButton() {
  const { carts, activeCartId, count, customerName, setOpen, switchCart, deleteCart } = useCart();
  const activeName = customerName.trim();
  const hasCarts = carts.length > 0;

  return (
    <div className="relative inline-flex h-9 items-center rounded-lg bg-secondary ring-1 ring-hairline">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open cart${activeName ? ` for ${activeName}` : ""}`}
        className={`inline-flex h-full items-center gap-2 px-2.5 transition hover:bg-accent active:scale-95 ${
          hasCarts ? "rounded-l-lg" : "rounded-lg"
        }`}
      >
        <ShoppingCart className="size-5" />
        {activeName && <span className="hidden max-w-28 truncate text-sm font-medium sm:inline">{activeName}</span>}
      </button>

      {hasCarts && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Switch customer cart"
            className="grid h-full place-items-center rounded-r-lg border-l border-hairline px-1.5 transition hover:bg-accent"
          >
            <ChevronDown className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            alignOffset={12}
            sideOffset={8}
            collisionPadding={12}
            className="w-[min(15rem,calc(100vw-2rem))] p-1.5"
          >
            <DropdownMenuLabel className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Customer carts
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="mb-1" />
            {carts.map((c) => {
              const name = c.customerName.trim() || "Unnamed";
              const isActive = c.id === activeCartId;
              return (
                <DropdownMenuItem
                  key={c.id}
                  onClick={() => switchCart(c.id)}
                  className={`gap-2.5 rounded-lg px-2 py-2 ${isActive ? "bg-secondary" : ""}`}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <User className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                  <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                    {c.count}
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete ${name}'s cart`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      deleteCart(c.id);
                    }}
                    className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-danger/10 hover:text-danger-foreground"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {count > 0 && (
        <span className="pointer-events-none absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold leading-5 text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </div>
  );
}

export default CartButton;
