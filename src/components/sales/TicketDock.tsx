"use client";

import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Receipt, ShoppingCart } from "lucide-react";
import { PosTicket } from "./PosTicket";
import { useTicket } from "./ticket-context";
import { useOrg } from "@/hooks/use-org";
import { money } from "@/lib/money";

/**
 * The till, everywhere.
 *
 * A counter does not stop being a counter because someone walked over to check
 * a purchase or a report. The ticket lives in the authenticated layout, so it
 * survives navigation, and this floats it over the right of every page:
 * expanded while a sale is in progress, out of the way when there isn't one.
 *
 * It rests ON the page rather than taking a column out of it. The page keeps its
 * own width either way, so opening the till never reflows what you were looking
 * at — and the page underneath stays clickable, which is the point: you can add
 * to the ticket from Inventory without putting it away first.
 *
 * On /sales it renders nothing — that page already shows the ticket as half the
 * screen, and two of them would be two different things claiming to be the same
 * sale.
 */
export function TicketDock() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useOrg();
  const t = useTicket();
  const open = t.dockOpen;
  const toggle = t.setDockOpen;
  const hasItems = t.unitCount > 0;

  // Escape closes it, as it should for anything laid over the page. Collapsing
  // the dock only hides it — the sale on it is untouched.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggle(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, toggle]);

  // The Sales page owns the ticket when you are on it.
  if (pathname === "/sales" || pathname.startsWith("/sales/")) return null;

  return (
    <>
      {/* Collapsed: a tab on the right edge. Always there, so the till is one
          click away even when nothing is on it — and always MOUNTED, because a
          tab that is removed from the page cannot animate off it. It slides out
          to the right as the panel slides in, so the two read as one movement. */}
      <button
        type="button"
        onClick={() => toggle(true)}
        aria-label={hasItems ? `Open the ticket — ${t.unitCount} on it` : "Open the ticket"}
        inert={open}
        className={`fixed right-0 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-center gap-2 rounded-l-2xl border border-r-0 border-hairline bg-surface px-2.5 py-4 shadow-lg transition duration-300 ease-out hover:bg-secondary lg:flex ${
          open ? "pointer-events-none translate-x-full opacity-0" : "translate-x-0 opacity-100"
        }`}
      >
        <ShoppingCart className="size-4 text-muted-foreground" />
        {hasItems ? (
          <>
            <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold leading-5 text-primary-foreground">
              {t.unitCount}
            </span>
            <span className="[writing-mode:vertical-rl] text-[11px] font-medium tabular-nums text-muted-foreground">
              {money(t.total)}
            </span>
          </>
        ) : (
          <span className="[writing-mode:vertical-rl] text-[11px] font-medium text-muted-foreground">
            Sell
          </span>
        )}
      </button>

      {/* Inset from the edges with its own rounded corners and shadow: it reads
          as a panel resting on the page, which is what it now is, rather than as
          a column the page gave up. Kept mounted and slid off-screen rather than
          unmounted, so closing is as smooth as opening; `inert` keeps the hidden
          ticket out of tab order while it is parked. */}
      <aside
        aria-hidden={!open}
        inert={!open}
        className={`fixed bottom-4 right-4 top-4 z-40 hidden w-[380px] flex-col gap-2 overflow-hidden rounded-2xl bg-background p-3 shadow-2xl ring-1 ring-hairline transition duration-300 ease-out lg:flex ${
          open
            ? "translate-x-0 opacity-100"
            : "pointer-events-none translate-x-[calc(100%+2rem)] opacity-0"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => toggle(false)}
            aria-label="Collapse the ticket"
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary"
          >
            <ChevronRight className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => navigate({ to: "/sales" })}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Receipt className="size-3.5" />
            Open full till
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <PosTicket canSeeCost={isAdmin} />
        </div>
      </aside>

      {/* Small screens: a bar only once there is something to lose. It leads to
          the Sales page rather than opening a panel — there is no room here to
          price and pay on top of another page. */}
      {hasItems && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-background/95 p-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => navigate({ to: "/sales" })}
            className="flex h-12 w-full items-center gap-3 rounded-xl bg-primary px-4 text-primary-foreground transition active:scale-[0.99]"
          >
            <Receipt className="size-4 shrink-0" />
            <span className="text-sm font-semibold">
              {t.unitCount} unit{t.unitCount === 1 ? "" : "s"} on ticket
            </span>
            <span className="ml-auto text-sm font-semibold tabular-nums">{money(t.total)}</span>
          </button>
        </div>
      )}
    </>
  );
}
